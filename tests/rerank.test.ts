import { describe, expect, test } from "bun:test"
import { applyRerankOrderAnswer, parseRerankAnswer, type RankedMemory } from "../src/core.ts"

function ranked(ids: string[]): RankedMemory[] {
  return ids.map((id, i) => ({
    entry: { id, text: `fact ${id}`, category: "other", scope: "global", weight: 1, created: 0, lastSeen: 0, source: "dreamed" } as never,
    base: 10 - i,
    keywordHits: 0,
    core: false,
    rank: i + 1,
    final: 10 - i,
  }))
}

describe("parseRerankAnswer", () => {
  test("parses a valid permutation", () => {
    expect(parseRerankAnswer('{"order":[2,0,1]}', 3)).toEqual({ kind: "order", order: [2, 0, 1] })
  })

  test("strips markdown fences before parsing", () => {
    expect(parseRerankAnswer('```json\n{"order":[1,0]}\n```', 2)).toEqual({ kind: "order", order: [1, 0] })
  })

  test("an explicit empty order means ABSTAIN (no candidate is relevant)", () => {
    expect(parseRerankAnswer('{"order":[]}', 3)).toEqual({ kind: "abstain" })
  })

  test("out-of-range and non-integer indices are dropped", () => {
    const res = parseRerankAnswer('{"order":[5,-1,1,"x",0]}', 3)
    expect(res).toEqual({ kind: "order", order: [1, 0] })
  })

  test("missing order field or unparseable output is invalid (lexical fallback)", () => {
    expect(parseRerankAnswer("no json here", 3)).toEqual({ kind: "invalid" })
    expect(parseRerankAnswer('{"sorted":[1,0]}', 3)).toEqual({ kind: "invalid" })
  })
})

describe("rerank application", () => {
  const candidates = ranked(["a", "b", "c"])

  test("reorders candidates by the model's answer", () => {
    const out = applyRerankOrderAnswer(candidates, { kind: "order", order: [2, 0, 1] })
    expect(out.map((r) => r.entry.id)).toEqual(["c", "a", "b"])
  })

  test("abstention yields an EMPTY surface list (core slot only), not the lexical order", () => {
    const out = applyRerankOrderAnswer(candidates, { kind: "abstain" })
    expect(out).toHaveLength(0)
  })

  test("invalid answers fall back to the deterministic lexical order", () => {
    const out = applyRerankOrderAnswer(candidates, { kind: "invalid" })
    expect(out.map((r) => r.entry.id)).toEqual(["a", "b", "c"])
  })

  test("unranked candidates keep base-score order after the model's partial ranking", () => {
    const out = applyRerankOrderAnswer(candidates, { kind: "order", order: [1] })
    expect(out.map((r) => r.entry.id)).toEqual(["b", "a", "c"])
  })
})
