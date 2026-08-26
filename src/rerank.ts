// Optional semantic reranking stage (v1.5.1, made unit-testable in v1.6).
//
// The client is INJECTED so the whole mechanism — ordering, abstention,
// invalid-answer fallback, timeout fallback, caching, tool containment,
// sensitivity filtering — can be verified with deterministic fakes without an
// OpenCode server or a model. The caller passes the headless child session id
// it created (parented to the surfacing session).
//
// Containment: every promptAsync call carries SESSION_TOOLS_DENY_ALL, so the
// child has zero tools regardless of what the server would offer by default.
// Privacy: candidates flagged local-only are filtered out here too (defense
// in depth — retrieve() already excludes them upstream).

import { SESSION_TOOLS_DENY_ALL } from "./config.ts"
import { norm, parseRerankAnswer, type RankedMemory } from "./core.ts"

export const RERANK_TITLE = "memory-surfacing"

export type RerankOptions = {
  timeoutMs: number
  cacheMs: number
  log?: (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void
  /** called synchronously once the child session exists (registration hooks) */
  onChildCreated?: (childSessionID: string) => void
}

type CacheEntry = { at: number; order: string[]; abstain?: boolean }
const rerankCache = new Map<string, CacheEntry>()

export function clearRerankCacheForTests() {
  rerankCache.clear()
}

export function applyRerankOrder(candidates: RankedMemory[], order: string[]): RankedMemory[] {
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

async function waitForReply(
  client: any,
  sessionID: string,
  timeoutMs: number,
  after: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await client.session.messages({ path: { id: sessionID }, query: { limit: 20 } })
    const msgs: any[] = res?.data ?? []
    let last = ""
    for (const m of msgs) {
      if (m?.info?.role !== "assistant") continue
      const completed = m?.info?.time?.completed ?? m?.info?.time?.created ?? 0
      if (completed < after) continue
      const texts = (m?.parts ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text)
      if (texts.length > 0) last = texts[texts.length - 1]
    }
    if (last.trim()) return last
    await sleep(25)
  }
  return ""
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// Returns the reranked candidates, [] on explicit ABSTENTION (no candidate is
// relevant), or the input unchanged on invalid/timeout/error (deterministic
// lexical fallback — never guesses).
export async function rerankCandidates(
  client: any,
  sessionID: string,
  query: string,
  candidates: RankedMemory[],
  opts: RerankOptions,
  cleanup?: (childSessionID: string) => Promise<void>,
): Promise<RankedMemory[]> {
  if (candidates.length <= 1) return candidates
  const key = norm(query || " ")
  const cached = rerankCache.get(key)
  if (cached && Date.now() - cached.at < opts.cacheMs) {
    if (cached.abstain) return []
    return applyRerankOrder(candidates, cached.order)
  }

  // Defense in depth: never hand local-only facts to the model, even if an
  // upstream filter regressed.
  const visible = candidates.filter((c) => c.entry.sensitivity !== "local-only")
  if (visible.length <= 1) return candidates

  let childID: string | undefined
  try {
    const created = await client.session.create({ body: { title: RERANK_TITLE, parentID: sessionID } })
    childID = created?.data?.id
    if (!childID) return candidates
    opts.onChildCreated?.(childID)
    const lines = visible.map((r, i) => `[${i}] ${r.entry.text}`).join("\n")
    const prompt = `You are a memory retrieval judge. Decide which candidate memories actually help answer the user's question, then rank ONLY those, most relevant first. Use semantics, not just keywords: paraphrase and synonyms count. A memory that merely shares a word or an adjacent topic but does NOT answer the question must be excluded.

REPLY WITH STRICT JSON ONLY, nothing else:
- {"order":[i,j,...]} with the indices of relevant candidates, best first (reorder ALL relevant ones)
- {"order":[]} if NO candidate actually answers the question

QUESTION: ${query || "(empty)"}

CANDIDATES:
${lines}`
    await client.session.promptAsync({
      path: { id: childID },
      body: { parts: [{ type: "text", text: prompt }], tools: SESSION_TOOLS_DENY_ALL },
    })
    const answer = await Promise.race([
      waitForReply(client, childID, opts.timeoutMs * 20, Date.now()),
      sleep(opts.timeoutMs).then(() => ""),
    ])
    if (!answer) {
      opts.log?.("debug", "rerank timed out; lexical fallback", { sessionID })
      return candidates
    }
    const outcome = parseRerankAnswer(answer, visible.length)
    if (outcome.kind === "abstain") {
      rerankCache.set(key, { at: Date.now(), order: [], abstain: true })
      return []
    }
    if (outcome.kind === "invalid") {
      opts.log?.("debug", "rerank answer unparseable; lexical fallback", { sessionID })
      return candidates
    }
    const ids = outcome.order.map((i) => visible[i].entry.id)
    rerankCache.set(key, { at: Date.now(), order: ids })
    const byId = new Map(candidates.map((c) => [c.entry.id, c]))
    const orderedVisible = ids.map((id) => byId.get(id)!).filter(Boolean)
    // local-only candidates (excluded from judging) keep their lexical tail
    const rest = candidates.filter((c) => !ids.includes(c.entry.id))
    return [...orderedVisible, ...rest]
  } catch (err) {
    opts.log?.("debug", "rerank failed; lexical fallback", { sessionID, error: String(err) })
    return candidates
  } finally {
    if (childID) await cleanup?.(childID)
  }
}
