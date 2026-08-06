import { tool } from "@opencode-ai/plugin"
import { mkdir, open, readFile, rename, unlink, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import {
  addEntry,
  applyConsolidation,
  CORE_CATEGORIES,
  emptyStore,
  expandTopicKeywords,
  findSimilar,
  norm,
  normalizeStore,
  prune,
  score,
  tokens,
  topicKeywords,
} from "./core.ts"

// ---------------------------------------------------------------------------
// opencode long-term memory plugin (Dreaming-style)
//
// WRITE  — memory_* tools: the agent stores explicit facts at call time.
// DREAM  — when a session goes idle, a HEADLESS child session (parentID set,
//          therefore invisible in the session picker) is used to synthesize
//          new facts / update the summary; it is deleted right after.
// SURFACE— a <memory> block (summary + top facts) is injected into every
//          prompt via the system.transform hook.
// ---------------------------------------------------------------------------

const CONSOLIDATION_TITLE = "memory-consolidation"
const CONFIG = {
  off: process.env.OPENCODE_MEMORY_OFF === "1",
  debug: process.env.OPENCODE_MEMORY_DEBUG === "1",
  delayMs: Number(process.env.OPENCODE_MEMORY_DELAY_MS ?? 90000),
  maxEntries: Number(process.env.OPENCODE_MEMORY_MAX_ENTRIES ?? 400),
  maxFacts: Number(process.env.OPENCODE_MEMORY_MAX_FACTS ?? 18),
  maxChars: Number(process.env.OPENCODE_MEMORY_MAX_CHARS ?? 2400),
  transcriptChars: Number(process.env.OPENCODE_MEMORY_TRANSCRIPT_CHARS ?? 12000),
  sweepIntervalMs: Number(process.env.OPENCODE_MEMORY_SWEEP_MS ?? 10 * 60 * 1000),
  sweepStartMs: Number(process.env.OPENCODE_MEMORY_SWEEP_START_MS ?? 20000),
  sweepBatch: Number(process.env.OPENCODE_MEMORY_SWEEP_BATCH ?? 8),
  gcChildAgeMs: Number(process.env.OPENCODE_MEMORY_GC_CHILD_AGE_MS ?? 10 * 60 * 1000),
  inProgressTimeoutMs: Number(process.env.OPENCODE_MEMORY_INPROGRESS_TIMEOUT_MS ?? 10 * 60 * 1000),
}

const DATA_DIR =
  process.env.OPENCODE_MEMORY_DIR ?? path.join(os.homedir(), ".local", "share", "opencode", "memory")
const STORE_FILE = path.join(DATA_DIR, "store.json")
const STATE_FILE = path.join(DATA_DIR, "state.json")
const SUMMARY_FILE = path.join(DATA_DIR, "SUMMARY.md")
const LOCK_FILE = path.join(DATA_DIR, ".lock")

type Entry = import("./core.ts").Entry
type Store = import("./core.ts").Store

type InProgress = {
  targetTs: number
  startedAt: number
  childID?: string
}

type State = {
  sessions: Record<string, number>
  inProgress?: Record<string, InProgress>
}

// Single source of truth for categories lives in core.ts (CATEGORIES).

function now() {
  return Date.now()
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

type LogLevel = "debug" | "info" | "warn" | "error"

function log(
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (level === "debug" && !CONFIG.debug) return

  const client = clientRef
  if (!client?.app?.log) return

  // Non usare await: il logging non deve mai bloccare il plugin.
  void client.app
    .log({
      body: {
        service: "opencode-memory",
        level,
        message,
        extra,
      },
    })
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// Store I/O (atomic, cross-instance safe via lockfile)
// ---------------------------------------------------------------------------

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(DATA_DIR, { recursive: true }).catch(() => {})
  let fd: Awaited<ReturnType<typeof open>> | undefined
  for (let i = 0; i < 40; i++) {
    try {
      fd = await open(LOCK_FILE, "wx")
      break
    } catch {
      await sleep(50)
    }
  }
  if (!fd) throw new Error("memory store lock timeout")
  try {
    return await fn()
  } finally {
    await fd.close().catch(() => {})
    await unlink(LOCK_FILE).catch(() => {})
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true }).catch(() => {})
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8")
  await rename(tmp, file)
}

// Always read the store fresh from disk: the consolidation writes it inside
// its own lock, and a stale in-memory copy would make the consolidation
// prompt and the dedup guard see outdated entries (or none at all).
// No lock needed on read: writeJson uses an atomic rename, so we always see
// a complete file (old or new version). This also avoids nested locks inside
// the critical sections that call readStore() themselves.
async function readStore(): Promise<Store> {
  return normalizeStore(await readJson<Store>(STORE_FILE, emptyStore()))
}

async function getStore(): Promise<Store> {
  return readStore()
}

async function writeStore(store: Store) {
  await writeJson(STORE_FILE, store)
  await writeFile(
    SUMMARY_FILE,
    `# opencode memory summary\n\nUpdated: ${new Date(store.updatedAt).toISOString()}\n\n${store.summary || "_No summary yet — it is generated after the first consolidation._"}\n`,
    "utf8",
  )
}

async function getState(): Promise<State> {
  const state = await withLock(() => readJson<State>(STATE_FILE, { sessions: {}, inProgress: {} }))
  state.sessions = state.sessions ?? {}
  state.inProgress = state.inProgress ?? {}
  return state
}

async function saveState(state: State) {
  await withLock(() => writeJson(STATE_FILE, state))
}

// ---------------------------------------------------------------------------
// Scoring / similarity / pruning / consolidation live in core.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Consolidation (headless: child session, invisible in the session picker)
// ---------------------------------------------------------------------------

let consolidationIDs = new Set<string>()
let queue: string[] = []
let processing = false
let clientRef: any = undefined
const debounces = new Map<string, ReturnType<typeof setTimeout>>()

function enqueue(sessionID: string) {
  if (queue.includes(sessionID)) return
  queue.push(sessionID)
  void pump()
}

async function waitForReply(
  client: any,
  sessionID: string,
  timeoutMs: number,
  opts: { after?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 20 } })
    const msgs: any[] = res?.data ?? []
    let last = ""
    for (const m of msgs) {
      if (m?.info?.role !== "assistant") continue
      const completed = m?.info?.time?.completed ?? m?.info?.time?.created ?? 0
      if (opts.after !== undefined && completed < opts.after) continue
      const texts = (m?.parts ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text)
      if (texts.length > 0) last = texts[texts.length - 1]
    }
    if (last.trim()) return last
    await sleep(1500)
  }
  return ""
}

// Second-pass semantic dedup: the consolidation model may fail to follow the
// "no duplicate of an explicit entry" rule (weak models, cross-language). We
// ask a focused question in the SAME headless session and only add candidates
// that are NOT reported as duplicates.
async function dedupCheck(
  client: any,
  consSessionID: string,
  entries: Entry[],
  candidates: { text: string }[],
): Promise<Set<number>> {
  const skip = new Set<number>()
  if (candidates.length === 0 || entries.length === 0) return skip
  const entryLines = entries
    .map((e) => `${e.id} | ${e.source} | ${e.category} | ${e.text}`)
    .join("\n")
  const candidateLines = candidates.map((c, i) => `[${i}] ${c.text}`).join("\n")
  const prompt = `You are a deduplication checker for a memory store.

EXISTING MEMORY ENTRIES:
${entryLines}

CANDIDATE NEW FACTS:
${candidateLines}

For each candidate that is semantically equivalent to an existing entry (same meaning, ANY language, paraphrase — e.g. "the user likes green" == "L'utente preferisce il verde"), reply with that candidate's index in "duplicates". An entry with source=explicit always wins over a candidate. Candidates that describe something NEW are not duplicates.

REPLY WITH STRICT JSON ONLY:
{"duplicates":[0,2]}`
  try {
    await client.session.promptAsync({
      path: { id: consSessionID },
      body: { parts: [{ type: "text", text: prompt }], tools: DISABLED_TOOLS },
    })
    const answer = await waitForReply(client, consSessionID, 90_000, { after: Date.now() })
    const parsed = extractJson(answer)
    const dups = Array.isArray(parsed?.duplicates) ? parsed.duplicates : []
    for (const d of dups) {
      const idx = Number(d)
      if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length) skip.add(idx)
    }
    log("debug", "dedup check", { candidates: candidates.length, duplicates: skip.size })
  } catch (err) {
    log("debug", "dedup check failed", { error: String(err) })
  }
  return skip
}

async function pump() {
  if (processing) return
  processing = true
  try {
    while (queue.length) {
      const id = queue.shift()!
      try {
        await consolidate(id)
      } catch (err) {
        log("warn", "consolidation failed", { sessionID: id, error: String(err) })
      }
    }
  } finally {
    processing = false
  }
}

function scheduleConsolidation(sessionID: string) {
  if (CONFIG.off) return
  if (consolidationIDs.has(sessionID)) return
  const existing = debounces.get(sessionID)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    debounces.delete(sessionID)
    enqueue(sessionID)
  }, CONFIG.delayMs)
  debounces.set(sessionID, timer)
}

async function sessionInfo(client: any, sessionID: string) {
  const res = await client.session.get({ path: { id: sessionID } })
  log("debug", "session.get response", { sessionID, hasData: !!res?.data, hasError: !!res?.error, error: res?.error ?? undefined })
  return res?.data
}

function extractJson(text: string): any | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === "object") return parsed
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      /* fall through */
    }
  }
  const arrStart = trimmed.indexOf("[")
  const arrEnd = trimmed.lastIndexOf("]")
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(trimmed.slice(arrStart, arrEnd + 1))
    } catch {
      /* fall through */
    }
  }
  return undefined
}

// Tools disabled inside the headless consolidation session (nothing else is
// available either — we want a pure JSON answer).
const DISABLED_TOOLS: Record<string, boolean> = Object.fromEntries(
  ["memory_read", "memory_write", "memory_update", "memory_forget", "memory_clear"].map((t) => [t, false]),
)

async function consolidate(sessionID: string): Promise<void> {
  log("debug", "consolidate start", { sessionID })
  const session = await sessionInfo(clientRef, sessionID)
  log("debug", "sessionInfo result", { sessionID, ok: !!session, id: session?.id, title: session?.title, directory: session?.directory })
  if (!session) {
    log("debug", "consolidation skipped: session not found", { sessionID })
    return
  }

  const state = await getState()
  log("debug", "state loaded", { sessionID, marked: state.sessions[sessionID] ?? 0 })
  const messagesRes = await clientRef.session.messages({ path: { id: sessionID }, query: { limit: 120 } })
  log("debug", "messages loaded", { sessionID, count: messagesRes?.data?.length ?? -1 })
  const messages: any[] = messagesRes?.data ?? []
  // If the last message is an assistant message still streaming (no
  // time.completed yet), the conversation is not finished: consolidating now
  // would capture a partial transcript and, once the stream completes, the
  // guard would pass again (created < completed), causing a SECOND full
  // consolidation. Skip and let the next sweep pick it up.
  const lastMsg = messages[messages.length - 1]
  if (lastMsg?.info?.role === "assistant" && !lastMsg?.info?.time?.completed) {
    log("debug", "consolidation skipped: response still streaming", { sessionID })
    return
  }
  const lastTs = messages.reduce(
    (max: number, m: any) => Math.max(max, m?.info?.time?.completed ?? m?.info?.time?.created ?? 0),
    0,
  )
  log("debug", "lastTs computed", { sessionID, lastTs, marked: state.sessions[sessionID] ?? 0 })
  if (lastTs <= (state.sessions[sessionID] ?? 0)) return

  // Two-phase guard: if a consolidation for this session is already in
  // progress (and not stale), skip. A stale inProgress means the previous
  // process died mid-consolidation: recover and retry — the orphan child is
  // removed later by gcConsolidationChildren().
  const ip = state.inProgress?.[sessionID]
  if (ip) {
    if (now() - ip.startedAt < CONFIG.inProgressTimeoutMs) {
      log("debug", "consolidation skipped: already in progress", { sessionID })
      return
    }
    log("debug", "recovering stale inProgress", { sessionID, startedAt: ip.startedAt, childID: ip.childID })
  }

  const transcript = messages
    .map((m: any) => {
      const role = m?.info?.role ?? "unknown"
      const text = (m?.parts ?? [])
        .map((p: any) => (p?.type === "text" ? p.text : `[${p?.type ?? "part"}]`))
        .join("\n")
      return `${role}: ${text}`
    })
    .join("\n\n")
    .slice(-CONFIG.transcriptChars)

  const store = await getStore()
  const entriesBlock =
    store.entries.length === 0
      ? "(none)"
      : store.entries
          .map((e) => `- [${e.id}] (${e.scope}/${e.category}, w=${e.weight.toFixed(1)}, source=${e.source}) ${e.text}`)
          .join("\n")

  const prompt = `You are the memory consolidation module of opencode. You silently read a finished conversation and update the long-term memory store.

TASKS:
1. new: facts about the user (preferences, constraints, personal details, decisions, project state) that are NOT already in memory. Be concise, third person ("The user...").
2. update: only entries whose fact genuinely CHANGED in the conversation (e.g. "The user changed jobs" replaces the old one). Never use update for mere reformulation.
3. delete: ids of entries that are outdated or contradicted.
4. summary: 2-5 sentence summary of who the user is and how they like to work.

SOURCE HIERARCHY (critical):
- Entries tagged source=explicit were stated directly by the user and ALWAYS win over source=dreamed (inferred) ones.
- NEVER add a "new" fact that is semantically equivalent to an explicit entry. Equivalence is BROAD: same meaning in ANY language, different wording, or paraphrase — e.g. "The user likes green" == "L'utente preferisce il verde", "the user codes in Rust" == "all'utente piace programmare in Rust", "the user prefers Rust" == "the user uses Rust".
- ANY fact about the same user attribute/topic as an existing entry (same preference, skill, habit, constraint, decision) is a DUPLICATE, regardless of wording or language. Only add a new fact when it describes a DIFFERENT attribute.
- NEVER delete or update explicit entries, even when the conversation contradicts them.
- A contradiction with an explicit entry must be IGNORED COMPLETELY: never add it as a "new" fact AND never mention it in the summary. The summary is injected into every future conversation, so mentioning the conflict there would reintroduce it through the back door.
- If a "new" fact duplicates a DREAMED entry, put the old dreamed entry's id in "delete" and the better formulation in "new" — exactly one entry survives.
- If a dreamed entry contradicts an explicit one, put the dreamed entry's id in "delete".

RULES:
- Do NOT invent facts; extract only what the conversation actually says.
- Skip trivial small talk and one-off actions.
- If nothing new, return empty arrays but still a summary ("" if no change).
- Write facts in the same language the user used in the conversation.
- Existing entries may be written in a DIFFERENT language: compare MEANING, not wording. Before adding a fact, ask yourself "does any existing entry already state this?" — if yes, it is a duplicate.
- scope "project" ONLY for facts tied to this specific codebase; everything else "global".

RESPOND WITH STRICT JSON ONLY. No markdown fences, no commentary, nothing before or after:
{"new":[{"text":"...","category":"user|project|workflow|preferences|decisions|status|environment|other","scope":"global|project"}],"update":[{"id":"...","text":"..."}],"delete":["..."],"summary":"..."}

CURRENT MEMORY ENTRIES:
${entriesBlock}

TRANSCRIPT (session title: ${session.title}):
${transcript}`

  // Phase 1 of the two-phase commit: record the intent, but do NOT advance
  // lastCompletedTs yet. lastCompletedTs is only committed after the store
  // has actually been updated (phase 2, inside the try). This gives
  // at-least-once semantics without duplicates: a crash after this point
  // leaves a stale inProgress that the next sweep recovers and retries.
  state.inProgress![sessionID] = { targetTs: lastTs, startedAt: now() }
  await saveState(state)

  let consSessionID: string | undefined
  try {
    const created = await clientRef.session.create({
      body: { title: CONSOLIDATION_TITLE, parentID: sessionID },
    })
    consSessionID = created?.data?.id
    if (!consSessionID) throw new Error("failed to create consolidation session")
    consolidationIDs.add(consSessionID)
    // Record the child id so a crashed run can be linked to its orphan.
    state.inProgress![sessionID].childID = consSessionID
    await saveState(state)

    await clientRef.session.promptAsync({
      path: { id: consSessionID },
      body: { parts: [{ type: "text", text: prompt }], tools: DISABLED_TOOLS },
    })
    const answer = await waitForReply(clientRef, consSessionID, 120_000, { after: Date.now() })
    if (!answer) throw new Error("consolidation timed out")
    const parsed = extractJson(answer)
    if (!parsed || !Array.isArray(parsed.new)) throw new Error("consolidation returned no usable JSON")

    if (Array.isArray(parsed.new) && parsed.new.length > 0 && store.entries.length > 0) {
      const skip = await dedupCheck(clientRef, consSessionID, store.entries, parsed.new)
      if (skip.size > 0) {
        log("debug", "dedup applied", { skipped: skip.size, texts: parsed.new.filter((_: any, i: number) => skip.has(i)).map((x: any) => x?.text) })
        parsed.new = parsed.new.filter((_: any, i: number) => !skip.has(i))
      }
    }

    await withLock(async () => {
      const fresh = await readStore()
      applyConsolidation(fresh, parsed, session.directory, now(), log)
      prune(fresh, now(), CONFIG.maxEntries)
      await writeStore(fresh)
    })

    // Phase 2: the store is updated, so commit lastCompletedTs. The final
    // saveState in the finally block persists this along with the inProgress
    // removal.
    state.sessions[sessionID] = lastTs
    log("info", "consolidated session", { sessionID, newFacts: parsed.new?.length ?? 0 })
  } catch (err) {
    log("warn", "consolidation error", { sessionID, error: String(err) })
  } finally {
    // Remove the inProgress marker (also on failure: the sweep will retry the
    // session because lastCompletedTs was not advanced).
    delete state.inProgress![sessionID]
    await saveState(state).catch(() => {})
    if (consSessionID) {
      consolidationIDs.delete(consSessionID)
      await clientRef.session.delete({ path: { id: consSessionID } }).catch(() => {})
    }
  }
}

// Garbage collection of orphaned consolidation children: if the process
// dies after creating the child but before the finally cleanup, the child
// stays (invisible in the picker, but present). A child is removed only when
// BOTH conditions hold: it is older than gcChildAgeMs AND shows no recent
// activity (updated < cutoff) — a slow but live consolidation must never be
// killed. Children referenced by a valid (unexpired) inProgress marker are
// exempt even across processes (a second server instance must not delete the
// child of a live one).
async function gcConsolidationChildren() {
  try {
    const state = await getState()
    const activeChildren = new Set<string>()
    const cutoff = now() - CONFIG.gcChildAgeMs
    for (const ip of Object.values(state.inProgress ?? {})) {
      if (ip.childID && now() - ip.startedAt < CONFIG.inProgressTimeoutMs) activeChildren.add(ip.childID)
    }
    const res = await clientRef.session.list({ query: {} })
    const sessions: any[] = res?.data ?? []
    let removed = 0
    for (const s of sessions) {
      if (consolidationIDs.has(s.id)) continue
      if (activeChildren.has(s.id)) continue
      if (s?.title !== CONSOLIDATION_TITLE) continue
      const created = s?.time?.created ?? 0
      const updated = s?.time?.updated ?? 0
      if (created > 0 && created < cutoff && updated < cutoff) {
        await clientRef.session.delete({ path: { id: s.id } }).catch(() => {})
        removed++
      }
    }
    if (removed > 0) log("info", "gc removed orphan consolidation sessions", { removed })
  } catch (err) {
    log("warn", "gc failed", { error: String(err) })
  }
}

async function sweep() {
  if (CONFIG.off) return
  await gcConsolidationChildren()
  try {
    const res = await clientRef.session.list({ query: {} })
    const sessions: any[] = res?.data ?? []
    const state = await getState()
    const candidates: any[] = []
    for (const s of sessions) {
      if (consolidationIDs.has(s.id)) continue
      // Consolidation children are never consolidated themselves (they are
      // handled by the GC).
      if (s?.title === CONSOLIDATION_TITLE) continue
      const lastTs = state.sessions[s.id] ?? 0
      if (lastTs !== 0) continue
      // A session with a valid (unexpired) inProgress marker is being
      // consolidated right now (possibly by another process): do not re-queue.
      const ip = state.inProgress?.[s.id]
      if (ip && now() - ip.startedAt < CONFIG.inProgressTimeoutMs) continue
      candidates.push(s)
    }
    candidates.sort((a, b) => (b?.time?.updated ?? 0) - (a?.time?.updated ?? 0))
    for (const s of candidates.slice(0, CONFIG.sweepBatch)) {
      enqueue(s.id)
    }
    if (candidates.length > 0) log("debug", "sweep queued", { count: Math.min(candidates.length, CONFIG.sweepBatch) })
  } catch (err) {
    log("warn", "sweep failed", { error: String(err) })
  }
}

// ---------------------------------------------------------------------------
// Memory block injection (proactive surfacing)
// ---------------------------------------------------------------------------

async function sessionTopicKeywords(client: any, sessionID: string): Promise<string[]> {
  try {
    const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 8 } })
    const msgs: any[] = res?.data ?? []
    const lastUser = [...msgs].reverse().find((m) => m?.info?.role === "user")
    const text = (lastUser?.parts ?? [])
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text)
      .join(" ")
    return topicKeywords(text)
  } catch {
    return []
  }
}

async function buildMemoryBlock(client: any, sessionID: string): Promise<string | undefined> {
  const store = await getStore()
  if (store.entries.length === 0 && !store.summary) return undefined
  const session = await sessionInfo(client, sessionID)
  const directory = session?.directory
  const t = now()

  const candidates = store.entries.filter(
    (e) => e.scope === "global" || (e.scope === "project" && e.projectID === directory),
  )
  const keywords = await sessionTopicKeywords(client, sessionID)
  const expanded = expandTopicKeywords(keywords)
  log("debug", "surface topic", { sessionID, keywords: keywords.slice(0, 12), expanded: expanded.slice(0, 12) })

  const ranked = candidates
    .map((e) => {
      if (expanded.length === 0) return { e, relevance: 0 }
      const et = norm(e.text)
      const hits = expanded.filter((k) => et.includes(k) || e.category === k).length
      return { e, relevance: hits }
    })
    .sort((a, b) => score(b.e, t) + b.relevance * 3 - (score(a.e, t) + a.relevance * 3))
    .slice(0, CONFIG.maxFacts)
    .map((x) => x.e)

  const selected = new Set(ranked.map((e) => e.id))
  const core = candidates
    .filter((e) => CORE_CATEGORIES.has(e.category) && !selected.has(e.id))
    .sort((a, b) => score(b, t) - score(a, t))
    .slice(0, 3)
  const entries = ranked.length < CONFIG.maxFacts ? [...ranked, ...core] : ranked

  const lines: string[] = []
  lines.push("<memory>")
  lines.push("The following is long-term memory from previous conversations with this user. Use it to personalize responses and follow established preferences. If something contradicts newer information, trust the newer information.")
  if (store.summary) {
    lines.push(`<summary>${store.summary}</summary>`)
  }
  if (entries.length > 0) {
    lines.push("<facts>")
    for (const e of entries) {
      lines.push(`- [${e.source}] (${e.category}) ${e.text}`)
    }
    lines.push("</facts>")
  }
  lines.push("</memory>")
  let block = lines.join("\n")
  if (block.length > CONFIG.maxChars) block = block.slice(0, CONFIG.maxChars - 1) + "…"
  return block
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async ({ client }: { client: any }) => {
  clientRef = client
  if (CONFIG.off) {
    log("info", "memory disabled via OPENCODE_MEMORY_OFF=1")
    return {}
  }

  const loaded = await getStore()
  log("info", `memory plugin loaded (${loaded.entries.length} entries, summary ${loaded.summary.length} chars)`)

  const timer = setTimeout(() => void sweep(), CONFIG.sweepStartMs)
  const interval = setInterval(() => void sweep(), CONFIG.sweepIntervalMs)

  return {
    dispose: async () => {
      clearTimeout(timer)
      clearInterval(interval)
      for (const t of debounces.values()) clearTimeout(t)
      debounces.clear()
    },

    event: async ({ event }: { event: any }) => {
      try {
        log("debug", "event received", { type: event?.type })
        if (event?.type === "session.idle" && event?.properties?.sessionID) {
          log("debug", "idle event -> schedule", { sessionID: event.properties.sessionID })
          scheduleConsolidation(event.properties.sessionID)
        } else if (
          event?.type === "session.status" &&
          event?.properties?.status?.type === "idle" &&
          event?.properties?.sessionID
        ) {
          log("debug", "status idle event -> schedule", { sessionID: event.properties.sessionID })
          scheduleConsolidation(event.properties.sessionID)
        }
      } catch (err) {
        log("debug", "event handler error", { error: String(err) })
      }
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      try {
        log("debug", "system transform called", { sessionID: input.sessionID, systemCount: output.system.length })
        if (!input.sessionID) return
        if (consolidationIDs.has(input.sessionID)) return
        const block = await buildMemoryBlock(client, input.sessionID)
        log("debug", "system transform block", { sessionID: input.sessionID, blockLen: block?.length ?? 0 })
        if (block) output.system.push(block)
      } catch (err) {
        log("debug", "system transform error", { error: String(err) })
      }
    },

    tool: {
      memory_read: tool({
        description:
          "Read facts stored in long-term memory. Use this when you need the user's preferences, constraints, or project decisions from previous sessions (like ChatGPT's memory recall).",
        args: {
          query: tool.schema.string().optional().describe("Optional text to filter facts by topic"),
          category: tool.schema.string().optional().describe("Optional category filter: user, project, workflow, preferences, decisions, status, environment, other"),
          scope: tool.schema.enum(["global", "project"]).optional().describe("Filter by scope"),
        },
        async execute(args) {
          const store = await getStore()
          const q = String(args.query ?? "").trim().toLowerCase()
          const cat = args.category ? String(args.category) : undefined
          const scope = args.scope === "project" ? "project" : args.scope === "global" ? "global" : undefined
          const hits = store.entries
            .filter((e) => (!q || e.text.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)))
            .filter((e) => !cat || e.category === cat)
            .filter((e) => !scope || e.scope === scope)
            .sort((a, b) => score(b) - score(a))
          if (hits.length === 0) return "No memory entries found."
          return [
            store.summary ? `Summary: ${store.summary}` : null,
            ...hits.map((e) => `- [${e.id}] (${e.scope}/${e.category}, ${e.source}) ${e.text}`),
          ]
            .filter(Boolean)
            .join("\n")
        },
      }),

      memory_write: tool({
        description:
          "Store a durable fact about the user or the project in long-term memory so future sessions remember it (like ChatGPT's 'remember that...'). Use for preferences, constraints, personal details, project decisions, and status that should persist.",
        args: {
          fact: tool.schema.string().describe("The fact to remember, third person about the user, e.g. 'The user prefers TypeScript over JavaScript'"),
          category: tool.schema.string().optional().describe("Optional category: user, project, workflow, preferences, decisions, status, environment, other"),
          scope: tool.schema.enum(["global", "project"]).optional().describe("'global' applies everywhere; 'project' only in this codebase (default global)"),
        },
        async execute(args, ctx) {
          const text = String(args.fact ?? "").trim()
          if (!text) return "No fact provided."
          const scope: Entry["scope"] = args.scope === "project" ? "project" : "global"
          await withLock(async () => {
            const fresh = await readStore()
            const existing = findSimilar(fresh.entries, text)
            if (existing) {
              existing.text = text
              existing.source = "explicit"
              existing.weight = Math.min(4, existing.weight + 0.5)
              existing.lastSeen = now()
              if (args.category) existing.category = String(args.category)
              if (scope === "project" && !existing.projectID) existing.projectID = ctx.directory
            } else {
              addEntry(fresh, {
                text,
                category: String(args.category ?? "other"),
                scope,
                projectID: scope === "project" ? ctx.directory : undefined,
                weight: 3,
                lastSeen: now(),
                source: "explicit",
                created: now(),
              })
            }
            fresh.updatedAt = now()
            prune(fresh, now(), CONFIG.maxEntries)
            await writeStore(fresh)
          })
          return `Remembered (${scope}): ${text}`
        },
      }),

      memory_update: tool({
        description:
          "Correct an existing memory entry (e.g. the user changed jobs, moved, or a preference changed). Provide either id (from memory_read) or match text; the new fact replaces the old one.",
        args: {
          id: tool.schema.string().optional().describe("Entry id from memory_read"),
          match: tool.schema.string().optional().describe("Text of the entry to update"),
          fact: tool.schema.string().describe("The corrected fact"),
        },
        async execute(args) {
          const fact = String(args.fact ?? "").trim()
          if (!fact) return "No fact provided."
          let updated = 0
          await withLock(async () => {
            const fresh = await readStore()
            const target = args.id
              ? fresh.entries.find((e) => e.id === args.id)
              : args.match
                ? findSimilar(fresh.entries, String(args.match))
                : undefined
            if (target) {
              target.text = fact
              target.weight = Math.min(4, target.weight + 0.5)
              target.lastSeen = now()
              updated = 1
            }
            fresh.updatedAt = now()
            await writeStore(fresh)
          })
          return updated ? `Updated: ${fact}` : "No matching entry found."
        },
      }),

      memory_forget: tool({
        description: "Remove a fact from long-term memory. Provide either id (from memory_read) or text to match.",
        args: {
          id: tool.schema.string().optional().describe("Entry id from memory_read"),
          match: tool.schema.string().optional().describe("Text of the entry to delete"),
        },
        async execute(args) {
          let removed = 0
          await withLock(async () => {
            const fresh = await readStore()
            const before = fresh.entries.length
            fresh.entries = fresh.entries.filter((e) => {
              if (args.id && e.id === args.id) return false
              if (args.match) {
                const m = String(args.match).toLowerCase()
                if (m.length > 3 && e.text.toLowerCase().includes(m)) return false
              }
              return true
            })
            removed = before - fresh.entries.length
            if (removed) fresh.summary = ""
            fresh.updatedAt = now()
            await writeStore(fresh)
          })
          return removed ? `Forgot ${removed} entr${removed === 1 ? "y" : "ies"}.` : "No matching entry found."
        },
      }),

      memory_clear: tool({
        description: "Delete all stored memory (or only 'global'/'project' scoped facts).",
        args: {
          scope: tool.schema.enum(["global", "project"]).optional().describe("Only clear this scope; default clears everything"),
        },
        async execute(args) {
          let removed = 0
          await withLock(async () => {
            const fresh = await readStore()
            const before = fresh.entries.length
            if (args.scope) {
              fresh.entries = fresh.entries.filter((e) => e.scope !== args.scope)
              removed = before - fresh.entries.length
            } else {
              fresh.entries = []
              removed = before
            }
            if (removed) fresh.summary = ""
            fresh.updatedAt = now()
            await writeStore(fresh)
          })
          return removed ? `Cleared ${removed} memory entr${removed === 1 ? "y" : "ies"}.` : "Memory already empty."
        },
      }),
    },
  }
}
