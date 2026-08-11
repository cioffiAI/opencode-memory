import { tool } from "@opencode-ai/plugin"
import { mkdir, open, readFile, rename, unlink, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import {
  addEntry,
  applyConsolidation,
  coreSlot,
  DAY,
  emptyStore,
  findSimilar,
  KEYWORD_BONUS,
  norm,
  normalizeStore,
  prune,
  retrieve,
  score,
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
  // Hybrid retrieval: optional semantic reranking stage. Off by default;
  // when enabled it reranks the lexical candidate window through a headless
  // LLM call, cached per query and bounded by a timeout that falls back to
  // the lexical order on any delay.
  rerank: process.env.OPENCODE_MEMORY_RERANK === "1",
  rerankCandidates: Number(process.env.OPENCODE_MEMORY_RERANK_CANDIDATES ?? 30),
  rerankTimeoutMs: Number(process.env.OPENCODE_MEMORY_RERANK_TIMEOUT_MS ?? 4000),
  rerankCacheMs: Number(process.env.OPENCODE_MEMORY_RERANK_CACHE_MS ?? 60 * 1000),
  coreSlot: Number(process.env.OPENCODE_MEMORY_CORE_SLOT ?? 3),
  // Surface feedback: lastSeen/useCount of surfaced memories are persisted
  // at most once per entry per interval, to avoid IO on every prompt.
  surfaceRefreshMs: Number(process.env.OPENCODE_MEMORY_SURFACE_REFRESH_MS ?? 15 * 60 * 1000),
}

const DATA_DIR =
  process.env.OPENCODE_MEMORY_DIR ?? path.join(os.homedir(), ".local", "share", "opencode", "memory")
const STORE_FILE = path.join(DATA_DIR, "store.json")
const STATE_FILE = path.join(DATA_DIR, "state.json")
const SUMMARY_FILE = path.join(DATA_DIR, "SUMMARY.md")
const LOCK_FILE = path.join(DATA_DIR, ".lock")

type Entry = import("./core.ts").Entry
type Store = import("./core.ts").Store
type RankedMemory = import("./core.ts").RankedMemory

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

  const messageIDs = messages
    .filter((m: any) => m?.id || m?.info?.id)
    .map((m: any) => String(m?.id ?? m?.info?.id))
    .slice(-20)

  const store = await getStore()
  // local-only facts never leave the machine: they are excluded from the
  // consolidation prompt (the transcript itself is still processed by the
  // provider, as documented in the README).
  const visible = store.entries.filter((e) => e.sensitivity !== "local-only")
  const entriesBlock =
    visible.length === 0
      ? "(none)"
      : visible
          .map((e) => `- [${e.id}] (${e.scope}/${e.category}, w=${e.weight.toFixed(1)}, source=${e.source}) ${e.text}`)
          .join("\n")

  const prompt = `You are the memory consolidation module of opencode. You silently read a finished conversation and update the long-term memory store.

TASKS:
1. new: facts about the user (preferences, constraints, personal details, decisions, project state) that are NOT already in memory. Be concise, third person ("The user...").
2. update: only entries whose fact genuinely CHANGED in the conversation (e.g. "The user changed jobs" replaces the old one). Never use update for mere reformulation.
3. delete: ids of entries that are outdated or contradicted.
4. conflicts: if the conversation STRONGLY contradicts an entry tagged source=explicit (the user says something that invalidates it, e.g. "I always use npm" vs "from now on I use Bun everywhere"), report it here with the entry id and a short evidence quote. Never modify or delete that entry — reporting is enough; the user resolves the conflict.
5. summary: 2-5 sentence summary of who the user is and how they like to work.

SOURCE HIERARCHY (critical):
- Entries tagged source=explicit were stated directly by the user and ALWAYS win over source=dreamed (inferred) ones.
- NEVER add a "new" fact that is semantically equivalent to an explicit entry. Equivalence is BROAD: same meaning in ANY language, different wording, or paraphrase — e.g. "The user likes green" == "L'utente preferisce il verde", "the user codes in Rust" == "all'utente piace programmare in Rust", "the user prefers Rust" == "the user uses Rust".
- ANY fact about the same user attribute/topic as an existing entry (same preference, skill, habit, constraint, decision) is a DUPLICATE, regardless of wording or language. Only add a new fact when it describes a DIFFERENT attribute.
- NEVER delete or update explicit entries, even when the conversation contradicts them: use the "conflicts" task instead.
- If a "new" fact duplicates a DREAMED entry, put the old dreamed entry's id in "delete" and the better formulation in "new" — exactly one entry survives.
- If a dreamed entry contradicts an explicit one, put the dreamed entry's id in "delete".

RULES:
- Do NOT invent facts; extract only what the conversation actually says.
- Skip trivial small talk and one-off actions.
- If nothing new, return empty arrays but still a summary ("" if no change).
- Write facts in the same language the user used in the conversation.
- Existing entries may be written in a DIFFERENT language: compare MEANING, not wording. Before adding a fact, ask yourself "does any existing entry already state this?" — if yes, it is a duplicate.
- scope "project" ONLY for facts tied to this specific codebase; everything else "global".
- Optionally attach "confidence" (0-1) to each new fact: how sure the conversation supports it.

RESPOND WITH STRICT JSON ONLY. No markdown fences, no commentary, nothing before or after:
{"new":[{"text":"...","category":"user|project|workflow|preferences|decisions|status|environment|other","scope":"global|project","confidence":0.9}],"update":[{"id":"...","text":"..."}],"delete":["..."],"conflicts":[{"id":"...","evidence":"..."}],"summary":"..."}

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
      applyConsolidation(fresh, parsed, session.directory, now(), log, {
        sessionID,
        messageIDs,
      })
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

const RERANK_TITLE = "memory-surfacing"

// Last retrieval snapshot per session, for the inspector's "surfaced" view.
const lastSurface = new Map<string, RankedMemory[]>()
const rerankCache = new Map<string, { at: number; order: string[] }>()

async function sessionTopicQuery(client: any, sessionID: string): Promise<string> {
  try {
    const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 8 } })
    const msgs: any[] = res?.data ?? []
    const lastUser = [...msgs].reverse().find((m) => m?.info?.role === "user")
    return (lastUser?.parts ?? [])
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p.text)
      .join(" ")
  } catch {
    return ""
  }
}

// Optional semantic stage of the hybrid pipeline: a headless LLM call reranks
// the lexical candidate window. Cached per query, bounded by a timeout that
// falls back to the lexical order, and disabled by default.
async function rerankCandidates(
  client: any,
  sessionID: string,
  query: string,
  candidates: RankedMemory[],
): Promise<RankedMemory[]> {
  if (candidates.length <= 1) return candidates
  const key = norm(query || " ")
  const cached = rerankCache.get(key)
  if (cached && now() - cached.at < CONFIG.rerankCacheMs) {
    return applyRerankOrder(candidates, cached.order)
  }
  let childID: string | undefined
  try {
    const created = await client.session.create({ body: { title: RERANK_TITLE, parentID: sessionID } })
    childID = created?.data?.id
    if (!childID) return candidates
    consolidationIDs.add(childID)
    const lines = candidates.map((r, i) => `[${i}] ${r.entry.text}`).join("\n")
    const prompt = `You are a memory retrieval reranker. Rank the candidate memories by relevance to the user question, most relevant first. Use semantics, not just keywords: paraphrase and synonyms count. Reorder ALL candidates. REPLY WITH STRICT JSON ONLY: {"order":[0,2,1,...]}

QUESTION: ${query || "(empty)"}

CANDIDATES:
${lines}`
    await client.session.promptAsync({
      path: { id: childID },
      body: { parts: [{ type: "text", text: prompt }], tools: DISABLED_TOOLS },
    })
    const answer = await Promise.race([
      waitForReply(client, childID, 90_000, { after: Date.now() }),
      sleep(CONFIG.rerankTimeoutMs).then(() => ""),
    ])
    if (!answer) return candidates
    const parsed = extractJson(answer)
    const order = Array.isArray(parsed?.order)
      ? parsed.order.map(Number).filter((i: number) => Number.isInteger(i) && i >= 0 && i < candidates.length)
      : []
    if (order.length === 0) return candidates
    const ids = order.map((i: number) => candidates[i].entry.id)
    rerankCache.set(key, { at: now(), order: ids })
    return applyRerankOrder(candidates, ids)
  } catch {
    return candidates
  } finally {
    if (childID) {
      consolidationIDs.delete(childID)
      await clientRef.session.delete({ path: { id: childID } }).catch(() => {})
    }
  }
}

function applyRerankOrder(candidates: RankedMemory[], order: string[]): RankedMemory[] {
  const pos = new Map(order.map((id, i) => [id, i]))
  return [...candidates].sort((a, b) => {
    const pa = pos.get(a.entry.id)
    const pb = pos.get(b.entry.id)
    if (pa === undefined && pb === undefined) return b.base - a.base
    if (pa === undefined) return 1
    if (pb === undefined) return -1
    return pa - pb
  })
}

// Persist surface feedback (lastUsed/useCount/lastSeen) at most once per
// entry per interval: surfaced memories stay alive through exposure without
// writing the store on every prompt.
async function markSurfaced(ids: string[], t = now()) {
  if (ids.length === 0) return
  try {
    await withLock(async () => {
      const s = await readStore()
      let changed = false
      for (const id of ids) {
        const e = s.entries.find((x) => x.id === id)
        if (!e) continue
        if (t - (e.lastUsed ?? 0) < CONFIG.surfaceRefreshMs) continue
        e.lastUsed = t
        e.useCount = (e.useCount ?? 0) + 1
        e.lastSeen = t
        changed = true
      }
      if (changed) await writeStore(s)
    })
  } catch (err) {
    log("debug", "markSurfaced failed", { error: String(err) })
  }
}

async function buildMemoryBlock(client: any, sessionID: string): Promise<string | undefined> {
  const store = await getStore()
  if (store.entries.length === 0 && !store.summary) return undefined
  const session = await sessionInfo(client, sessionID)
  const directory = session?.directory
  const t = now()

  const query = await sessionTopicQuery(client, sessionID)
  const ranked = retrieve(store, directory, query, t, {
    excludeSensitivity: new Set(["local-only"]),
    candidateCount: CONFIG.rerankCandidates,
  })
  const reranked = CONFIG.rerank ? await rerankCandidates(client, sessionID, query, ranked) : ranked
  // Relevance floor: without RERANK, only keyword-qualified memories enter
  // the relevance tier — a query that matches nothing surfaces nothing but
  // the core slot (no noise for off-topic prompts).
  const qualified = CONFIG.rerank ? reranked : reranked.filter((r) => r.keywordHits > 0)
  const top = qualified.slice(0, CONFIG.maxFacts)
  const selectedIds = new Set(top.map((r) => r.entry.id))
  const core = coreSlot(store, directory, selectedIds, t, CONFIG.coreSlot)
  const surfaced: RankedMemory[] = [
    ...top,
    ...core.map((e, i) => ({
      entry: e,
      base: score(e, t),
      keywordHits: 0,
      core: true,
      rank: top.length + i + 1,
      final: score(e, t),
    })),
  ]
  lastSurface.set(sessionID, surfaced)
  log("debug", "surface ranked", {
    sessionID,
    query: query.slice(0, 80),
    candidates: ranked.length,
    qualified: qualified.length,
    surfaced: surfaced.length,
  })
  void markSurfaced(surfaced.map((r) => r.entry.id), t)

  const lines: string[] = []
  lines.push("<memory>")
  lines.push("The following is long-term memory from previous conversations with this user. Use it to personalize responses and follow established preferences. If something contradicts newer information, trust the newer information.")
  if (store.summary) {
    lines.push(`<summary>${store.summary}</summary>`)
  }
  if (surfaced.length > 0) {
    lines.push("<facts>")
    for (const r of surfaced) {
      const e = r.entry
      const status = e.status === "CONFLICTED" ? ", conflicted" : ""
      lines.push(`- [${e.source}] (${e.category}${status}) ${e.text}`)
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
          "Store a durable fact about the user or the project in long-term memory so future sessions remember it (like ChatGPT's 'remember that...'). Use for preferences, constraints, personal details, project decisions, and status that should persist. If a CONFLICTED memory is rewritten here it is resolved.",
        args: {
          fact: tool.schema.string().describe("The fact to remember, third person about the user, e.g. 'The user prefers TypeScript over JavaScript'"),
          category: tool.schema.string().optional().describe("Optional category: user, project, workflow, preferences, decisions, status, environment, other"),
          scope: tool.schema.enum(["global", "project"]).optional().describe("'global' applies everywhere; 'project' only in this codebase (default global)"),
          tier: tool.schema.enum(["core", "archival", "temporary"]).optional().describe("core: always surfaced; archival: surfaced on relevance (default for non-critical facts); temporary: expires automatically"),
          ttlHours: tool.schema.number().optional().describe("Lifetime in hours for tier=temporary (default 24)"),
          pinned: tool.schema.boolean().optional().describe("If true the memory never decays (e.g. identity facts)"),
          sensitivity: tool.schema.enum(["normal", "private", "local-only"]).optional().describe("local-only: never surfaced to remote providers nor sent during consolidation; only visible through memory_read"),
        },
        async execute(args, ctx) {
          const text = String(args.fact ?? "").trim()
          if (!text) return "No fact provided."
          const scope: Entry["scope"] = args.scope === "project" ? "project" : "global"
          const tier: Entry["tier"] = args.tier === "temporary" || args.tier === "archival" || args.tier === "core" ? args.tier : undefined
          const sensitivity: Entry["sensitivity"] =
            args.sensitivity === "private" || args.sensitivity === "local-only" ? args.sensitivity : undefined
          const expiresAt =
            tier === "temporary"
              ? now() + Number(args.ttlHours ?? 24) * 60 * 60 * 1000
              : undefined
          let status = ""
          await withLock(async () => {
            const fresh = await readStore()
            const existing = findSimilar(fresh.entries, text)
            if (existing) {
              existing.text = text
              existing.source = "explicit"
              existing.weight = Math.min(4, existing.weight + 0.5)
              existing.lastSeen = now()
              existing.createdBy = "memory_write"
              existing.confidence = 1
              if (tier) existing.tier = tier
              if (existing.tier !== "temporary") existing.expiresAt = undefined
              if (args.pinned === true) existing.pinned = true
              if (args.pinned === false) existing.pinned = false
              if (sensitivity) existing.sensitivity = sensitivity
              if (args.category) existing.category = String(args.category)
              if (scope === "project" && !existing.projectID) existing.projectID = ctx.directory
              if (existing.status === "CONFLICTED") {
                existing.status = "ACTIVE"
                existing.conflictEvidence = undefined
                existing.conflictAt = undefined
                status = " (conflict resolved)"
              }
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
                createdBy: "memory_write",
                confidence: 1,
                tier: tier ?? (String(args.category ?? "other") === "other" ? "archival" : "core"),
                pinned: args.pinned === true ? true : undefined,
                expiresAt,
                sensitivity: sensitivity ?? "normal",
              })
            }
            fresh.updatedAt = now()
            prune(fresh, now(), CONFIG.maxEntries)
            await writeStore(fresh)
          })
          return `Remembered (${scope})${status}: ${text}`
        },
      }),

      memory_update: tool({
        description:
          "Correct an existing memory entry (e.g. the user changed jobs, moved, or a preference changed). Provide either id (from memory_read) or match text; the new fact replaces the old one. Resolves a CONFLICTED entry.",
        args: {
          id: tool.schema.string().optional().describe("Entry id from memory_read"),
          match: tool.schema.string().optional().describe("Text of the entry to update"),
          fact: tool.schema.string().describe("The corrected fact"),
        },
        async execute(args) {
          const fact = String(args.fact ?? "").trim()
          if (!fact) return "No fact provided."
          let updated = 0
          let resolvedConflict = false
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
              if (target.status === "CONFLICTED") {
                target.status = "ACTIVE"
                target.conflictEvidence = undefined
                target.conflictAt = undefined
                resolvedConflict = true
              }
              updated = 1
            }
            fresh.updatedAt = now()
            await writeStore(fresh)
          })
          return updated ? `Updated: ${fact}${resolvedConflict ? " (conflict resolved)" : ""}` : "No matching entry found."
        },
      }),

      memory_why: tool({
        description:
          "Explain where a memory entry comes from: provenance (session, messages, extraction time, confidence), lifecycle status and score breakdown. Use when the user asks why a memory exists or whether it can be trusted.",
        args: {
          id: tool.schema.string().describe("Entry id from memory_read"),
        },
        async execute(args) {
          const store = await getStore()
          const e = store.entries.find((x) => x.id === args.id)
          if (!e) return "No memory entry with this id."
          const t = now()
          const days = Math.max(0, (t - e.lastSeen) / DAY)
          const decay = Math.exp(-days / 45)
          const base = score(e, t)
          const lines: string[] = []
          lines.push(`Text: ${e.text}`)
          lines.push(`Source: ${e.source}${e.createdBy ? ` (via ${e.createdBy})` : ""}`)
          lines.push(`Category: ${e.category} | Scope: ${e.scope}${e.projectID ? ` | project: ${e.projectID}` : ""}`)
          if (e.source === "dreamed") {
            lines.push(`Extracted: ${e.extractedAt ? new Date(e.extractedAt).toISOString() : "unknown"}`)
            if (e.sourceSessionID) lines.push(`From session: ${e.sourceSessionID}`)
            if (e.sourceMessageIDs?.length) lines.push(`From messages: ${e.sourceMessageIDs.join(", ")}`)
            if (e.confidence !== undefined) lines.push(`Confidence: ${(e.confidence * 100).toFixed(0)}%`)
          } else {
            lines.push(`Stated directly by the user (${e.created ? new Date(e.created).toISOString() : "date unknown"})`)
          }
          lines.push(
            `Lifecycle: ${e.status ?? "ACTIVE"}${e.pinned ? " | pinned (no decay)" : ""}${e.tier ? ` | tier ${e.tier}` : ""}${
              e.expiresAt ? ` | expires ${new Date(e.expiresAt).toISOString()}` : ""
            }`,
          )
          if (e.status === "CONFLICTED") {
            lines.push(`Conflict: flagged on ${e.conflictAt ? new Date(e.conflictAt).toISOString() : "?"}`)
            lines.push(`Evidence: ${e.conflictEvidence ?? "—"}`)
            lines.push("Resolve it with memory_update (new fact) or memory_write (rewrite).")
          }
          lines.push(`Weight: ${e.weight.toFixed(2)} (base importance, never decayed in place)`)
          lines.push(`Usage: surfaced ${e.useCount ?? 0}x, helpful ${e.helpfulCount ?? 0}, irrelevant ${e.irrelevantCount ?? 0}`)
          lines.push(
            `Score (now): ${base.toFixed(3)} = (${e.weight.toFixed(2)} + source bonus + utilization) × decay ${decay.toFixed(3)} (age ${Math.round(days)}d)`,
          )
          for (const [sid, ranked] of lastSurface) {
            const hit = ranked.find((r) => r.entry.id === e.id)
            if (hit) {
              lines.push(`Last surfacing (session ${sid}):`)
              lines.push(`  Base score: ${hit.base.toFixed(2)}`)
              lines.push(`  Keyword match: ${hit.keywordHits > 0 ? `+${hit.keywordHits * KEYWORD_BONUS} (${hit.keywordHits} hits)` : "+0"}`)
              lines.push(`  Core slot: ${hit.core ? "yes" : "no"}`)
              lines.push(`  Final rank: #${hit.rank}`)
            }
          }
          lines.push(`Sensitivity: ${e.sensitivity ?? "normal"}`)
          return lines.join("\n")
        },
      }),

      memory_inspect: tool({
        description:
          "Inspect the memory store: stats (counts by source/scope/tier/status, context cost), recent entries, conflicts awaiting resolution, project-scoped entries, or the 'why surfaced' breakdown of the current session's retrieval.",
        args: {
          show: tool.schema.enum(["stats", "recent", "conflicts", "project", "surfaced"]).optional().describe("View to show (default stats)"),
          limit: tool.schema.number().optional().describe("Max entries in list views (default 10)"),
        },
        async execute(args, ctx) {
          const store = await getStore()
          const show = args.show ?? "stats"
          const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)))
          const out: string[] = []
          if (show === "stats") {
            const s = store
            const explicit = s.entries.filter((e) => e.source === "explicit").length
            const dreamed = s.entries.filter((e) => e.source === "dreamed").length
            const global = s.entries.filter((e) => e.scope === "global").length
            const project = s.entries.filter((e) => e.scope === "project").length
            const core = s.entries.filter((e) => e.tier === "core").length
            const archival = s.entries.filter((e) => e.tier === "archival").length
            const temporary = s.entries.filter((e) => e.tier === "temporary").length
            const pinned = s.entries.filter((e) => e.pinned).length
            const conflicted = s.entries.filter((e) => e.status === "CONFLICTED").length
            const superseded = s.entries.filter((e) => e.status === "SUPERSEDED").length
            const localOnly = s.entries.filter((e) => e.sensitivity === "local-only").length
            const privateCount = s.entries.filter((e) => e.sensitivity === "private").length
            const avgChars = s.entries.length ? Math.round(s.entries.reduce((a, e) => a + e.text.length, 0) / s.entries.length) : 0
            const catCounts = new Map<string, number>()
            for (const e of s.entries) catCounts.set(e.category, (catCounts.get(e.category) ?? 0) + 1)
            out.push("OpenCode Memory")
            out.push("")
            out.push(`Stored: ${s.entries.length}   Explicit: ${explicit}   Dreamed: ${dreamed}`)
            out.push(`Global: ${global}   Project: ${project}`)
            out.push(`Tier: core ${core} | archival ${archival} | temporary ${temporary} | pinned ${pinned}`)
            out.push(`Status: conflicted ${conflicted} | superseded (tombstones) ${superseded}`)
            out.push(`Sensitivity: local-only ${localOnly} | private ${privateCount}`)
            out.push(`Categories: ${[...catCounts.entries()].map(([c, n]) => `${c} ${n}`).join(", ")}`)
            out.push(`Summary: ${s.summary.length} chars   Avg fact: ${avgChars} chars   Est. full context cost: ${Math.round((s.summary.length + s.entries.reduce((a, e) => a + e.text.length, 0)) / 4)} tokens`)
            const totalSurface = [...lastSurface.values()].reduce((a, r) => a + r.length, 0)
            out.push(`Surfaced in last prompts: ${totalSurface}/${s.entries.length}`)
          } else if (show === "recent") {
            const list = [...store.entries].sort((a, b) => b.created - a.created).slice(0, limit)
            out.push(`Recent ${list.length} entries:`)
            for (const e of list) {
              out.push(`- [${e.id}] (${e.scope}/${e.category}, ${e.source}${e.status === "CONFLICTED" ? ", conflicted" : ""}) ${e.text}`)
            }
          } else if (show === "conflicts") {
            const list = store.entries.filter((e) => e.status === "CONFLICTED")
            if (list.length === 0) {
              out.push("No conflicts awaiting resolution.")
            } else {
              out.push(`${list.length} conflicted explicit memor${list.length === 1 ? "y" : "ies"} (resolve with memory_update):`)
              for (const e of list) {
                out.push(`- [${e.id}] ${e.text}`)
                out.push(`  evidence: ${e.conflictEvidence ?? "—"} (flagged ${e.conflictAt ? new Date(e.conflictAt).toISOString() : "?"})`)
              }
            }
          } else if (show === "project") {
            const dir = ctx.directory
            const list = store.entries.filter((e) => e.scope === "project").slice(0, limit)
            out.push(`Project entries (directory: ${dir ?? "unknown"}) — ${list.length}/${store.entries.filter((e) => e.scope === "project").length}:`)
            for (const e of list) {
              out.push(`- [${e.id}] (${e.category}, ${e.source}) ${e.text}`)
            }
          } else if (show === "surfaced") {
            const sid = ctx.sessionID ?? ""
            const ranked = lastSurface.get(sid)
            if (!ranked || ranked.length === 0) {
              out.push("No memory surfaced for this session yet. Send a message to trigger retrieval.")
            } else {
              out.push(`Why was this memory surfaced? (session ${sid}, latest retrieval)`)
              out.push("")
              for (const r of ranked) {
                const e = r.entry
                out.push(`Memory: "${e.text}"`)
                out.push(`  Base score:      ${r.base.toFixed(2)}`)
                out.push(`  Keyword match:   ${r.keywordHits > 0 ? `+${(r.keywordHits * KEYWORD_BONUS).toFixed(2)} (${r.keywordHits} hits)` : "+0.00"}`)
                out.push(`  Core bonus:      ${r.core ? "yes" : "no"}`)
                out.push(`  Final rank:      #${r.rank}`)
                out.push("")
              }
            }
          }
          return out.join("\n")
        },
      }),

      memory_useful: tool({
        description: "Tell the memory system that a surfaced memory was actually useful. Improves its future ranking and slows its decay.",
        args: {
          id: tool.schema.string().describe("Entry id from memory_read"),
        },
        async execute(args) {
          let ok = false
          await withLock(async () => {
            const fresh = await readStore()
            const target = fresh.entries.find((e) => e.id === args.id)
            if (target) {
              target.helpfulCount = (target.helpfulCount ?? 0) + 1
              target.useCount = (target.useCount ?? 0) + 1
              target.lastUsed = now()
              target.lastSeen = now()
              ok = true
            }
            fresh.updatedAt = now()
            await writeStore(fresh)
          })
          return ok ? "Noted as useful." : "No memory entry with this id."
        },
      }),

      memory_irrelevant: tool({
        description: "Tell the memory system that a surfaced memory was NOT relevant to the current task. Lowers its future ranking.",
        args: {
          id: tool.schema.string().describe("Entry id from memory_read"),
        },
        async execute(args) {
          let ok = false
          await withLock(async () => {
            const fresh = await readStore()
            const target = fresh.entries.find((e) => e.id === args.id)
            if (target) {
              target.irrelevantCount = (target.irrelevantCount ?? 0) + 1
              target.useCount = (target.useCount ?? 0) + 1
              target.lastUsed = now()
              ok = true
            }
            fresh.updatedAt = now()
            await writeStore(fresh)
          })
          return ok ? "Noted as irrelevant." : "No memory entry with this id."
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
