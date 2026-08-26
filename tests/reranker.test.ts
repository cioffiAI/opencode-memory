import { afterEach, describe, expect, test } from "bun:test"
import { applyRerankOrder, clearRerankCacheForTests, rerankCandidates, type RerankOptions } from "../src/rerank.ts"
import { SESSION_TOOLS_DENY_ALL } from "../src/config.ts"
import type { RankedMemory } from "../src/core.ts"

// Deterministic fake of the OpenCode client surface used by the reranker.
type Script = { answer: string; delayMs?: number } | { fail: Error }

function fakeClient(script: Script, captured: { prompts: string[]; tools: unknown[]; created: string[]; deleted: string[] }) {
  return {
    session: {
      create: async ({ body }: any) => {
        captured.created.push(body.title)
        return { data: { id: "child-1" } }
      },
      promptAsync: async ({ body }: any) => {
        captured.tools.push(body.tools)
        captured.prompts.push(body.parts[0].text)
        if ("fail" in script) throw script.fail
      },
      messages: async () => {
        if ("delayMs" in script && script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs!))
        const text = "answer" in script ? script.answer : ""
        return {
          data: [{ info: { role: "assistant", time: { completed: Date.now() - 1 } }, parts: [{ type: "text", text }] }],
        }
      },
      delete: async ({ path }: any) => {
        captured.deleted.push(path.id)
      },
    },
  }
}

function cand(id: string, text: string, sensitivity?: "local-only"): RankedMemory {
  return {
    entry: {
      id,
      text,
      category: "other",
      scope: "global",
      weight: 1,
      created: 0,
      lastSeen: 0,
      source: "dreamed",
      tier: "archival",
      status: "ACTIVE",
      sensitivity: sensitivity ?? "normal",
    } as never,
    base: 2,
    keywordHits: 1,
    matches: [{ keyword: "x", kind: "exact", direct: true }],
    core: false,
    rank: 1,
    final: 5,
  }
}

const opts = (over: Partial<RerankOptions> = {}): RerankOptions => ({
  timeoutMs: 500,
  cacheMs: 60_000,
  ...over,
})

afterEach(() => clearRerankCacheForTests())

describe("reranker mechanism (fake client)", () => {
  const candidates = [cand("a", "alpha fact"), cand("b", "beta fact"), cand("c", "gamma fact")]

  test("a valid order reorders candidates", async () => {
    const cap = { prompts: [] as string[], tools: [] as unknown[], created: [] as string[], deleted: [] as string[] }
    const out = await rerankCandidates(fakeClient({ answer: '{"order":[2,0,1]}' }, cap), "s1", "query?", candidates, opts())
    expect(out.map((r) => r.entry.id)).toEqual(["c", "a", "b"])
  })

  test("explicit abstention returns EMPTY (nothing surfaces beyond the core slot)", async () => {
    const cap = { prompts: [] as string[], tools: [] as unknown[], created: [] as string[], deleted: [] as string[] }
    const out = await rerankCandidates(fakeClient({ answer: '{"order":[]}' }, cap), "s1", "query?", candidates, opts())
    expect(out).toEqual([])
  })

  test("unparseable output falls back to the deterministic lexical order", async () => {
    const cap = { prompts: [] as string[], tools: [] as unknown[], created: [] as string[], deleted: [] as string[] }
    const out = await rerankCandidates(fakeClient({ answer: "sorry, I cannot help with that" }, cap), "s1", "query?", candidates, opts())
    expect(out.map((r) => r.entry.id)).toEqual(["a", "b", "c"])
  })

  test("timeout falls back to the lexical order and the child session is cleaned up", async () => {
    const cap = { prompts: [] as string[], tools: [] as unknown[], created: [] as string[], deleted: [] as string[] }
    const cleanuped: string[] = []
    const out = await rerankCandidates(
      fakeClient({ answer: '{"order":[1]}', delayMs: 400 }, cap),
      "s1",
      "query?",
      candidates,
      opts({ timeoutMs: 40 }),
      async (id) => {
        cleanuped.push(id)
      },
    )
    expect(out.map((r) => r.entry.id)).toEqual(["a", "b", "c"])
    expect(cleanuped).toEqual(["child-1"])
    await Bun.sleep(450)
    expect(cleanuped).toEqual(["child-1"])
  })

  test("client errors fall back to the lexical order (never throw to the caller)", async () => {
    const cap = { prompts: [] as string[], tools: [] as unknown[], created: [] as string[], deleted: [] as string[] }
    const out = await rerankCandidates(fakeClient({ fail: new Error("boom") }, cap), "s1", "query?", candidates, opts())
    expect(out.map((r) => r.entry.id)).toEqual(["a", "b", "c"])
  })

  test("every promptAsync carries the allow-none tool payload ({ '*': false })", async () => {
    const cap = { prompts: [] as string[], tools: [] as unknown[], created: [] as string[], deleted: [] as string[] }
    await rerankCandidates(fakeClient({ answer: '{"order":[]}' }, cap), "s1", "query?", candidates, opts())
    expect(cap.tools.length).toBeGreaterThan(0)
    for (const t of cap.tools) expect(t).toEqual(SESSION_TOOLS_DENY_ALL)
  })

  test("local-only candidates are filtered out of the prompt (defense in depth)", async () => {
    const cap = { prompts: [] as string[], tools: [] as unknown[], created: [] as string[], deleted: [] as string[] }
    const mixed = [
      cand("pub1", "public fact one"),
      cand("sec", "the user's API token is abc123", "local-only"),
      cand("pub2", "public fact two"),
    ]
    await rerankCandidates(fakeClient({ answer: '{"order":[0]}' }, cap), "s1", "query?", mixed, opts())
    expect(cap.prompts[0]).toContain("public fact")
    expect(cap.prompts[0]).not.toContain("abc123")
    // the secret candidate never enters the ranking either
    const res = await rerankCandidates(fakeClient({ answer: '{"order":[]}' }, cap), "s2", "query?", mixed, opts({ cacheMs: 0 }))
    expect(res.map((r) => r.entry.id)).toEqual([])
  })

  test("results are cached per query within the cache window", async () => {
    let calls = 0
    const client = {
      session: {
        create: async () => ({ data: { id: `child-${++calls}` } }),
        promptAsync: async () => {},
        messages: async () => ({
          data: [{ info: { role: "assistant", time: { completed: Date.now() - 1 } }, parts: [{ type: "text", text: '{"order":[1,0]}' }] }],
        }),
        delete: async () => {},
      },
    }
    await rerankCandidates(client, "s1", "same query", candidates, opts())
    const second = await rerankCandidates(client, "s1", "same query", candidates, opts())
    expect(calls).toBe(1)
    expect(second.map((r) => r.entry.id)).toEqual(["b", "a", "c"])
  })
})

describe("applyRerankOrder", () => {
  test("unranked candidates keep base-score order after the ranked prefix", () => {
    const cands = [
      { entry: { id: "a" } } as never,
      { entry: { id: "b" } } as never,
      { entry: { id: "c" } } as never,
    ].map((x, i) => ({ ...(x as object), base: 10 - i })) as unknown as RankedMemory[]
    const out = applyRerankOrder(cands, ["c"])
    expect(out.map((r) => r.entry.id)).toEqual(["c", "a", "b"])
  })
})
