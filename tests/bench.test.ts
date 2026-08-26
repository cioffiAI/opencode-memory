import { describe, expect, test } from "bun:test"
import { buildStore, computeMetrics, isNegative, NEGATIVE_TAGS, runScenario, SCENARIOS, type ScenarioResult } from "../bench/lib.ts"
import { retrieve } from "../src/core.ts"

describe("benchmark scenario suite integrity", () => {
  test("scenario ids are unique", () => {
    const ids = SCENARIOS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("every negative-tagged scenario expects nothing (falsifiable by construction)", () => {
    for (const s of SCENARIOS) {
      if (s.tags.some((t) => NEGATIVE_TAGS.has(t))) {
        expect(s.expected).toEqual([])
      }
    }
    // And the suite actually contains negatives — otherwise the FP metric
    // would be vacuous again.
    expect(SCENARIOS.some((s) => isNegative(s))).toBe(true)
  })

  test("all required negative categories are represented", () => {
    for (const tag of ["none", "hard-negative", "semantic-distractor", "xl-negative", "isolation-negative", "core-only"]) {
      const n = SCENARIOS.filter((s) => s.tags.includes(tag))
      expect(n.length, `missing negative category: ${tag}`).toBeGreaterThanOrEqual(3)
    }
  })

  test("superseded memories are excluded from the ranking entirely", () => {
    const store = buildStore([
      { text: "The user now uses Bun.", category: "preferences" },
      { text: "The user uses npm.", category: "preferences", status: "SUPERSEDED" },
    ])
    const res = retrieve(store, undefined, "package manager?", Date.now())
    expect(res.map((r) => r.entry.text)).toEqual(["The user now uses Bun."])
  })
})

describe("metrics computation", () => {
  const result = (over: Partial<ScenarioResult>): ScenarioResult => ({
    id: "x",
    tags: [],
    expected: [0],
    retrieved: [0],
    rankFirst: 1,
    qualifiedSurfaced: [0],
    coreSurfaced: [],
    falseSurfaced: [],
    chars: 100,
    ...over,
  })

  test("recall and MRR are computed over positives only", () => {
    const m = computeMetrics([
      result({ expected: [0], retrieved: [0], rankFirst: 1 }),
      result({ id: "neg", expected: [], retrieved: [], rankFirst: 0 }),
    ])
    expect(m.recallAt5).toBe(1)
    expect(m.mrr).toBe(1)
    expect(m.negatives).toBe(1)
  })

  test("a negative query with an irrelevant surfaced entry counts as a false positive", () => {
    const m = computeMetrics([
      result({ expected: [0], retrieved: [0], rankFirst: 1 }),
      result({ id: "n1", expected: [], qualifiedSurfaced: [7], falseSurfaced: [7] }),
      result({ id: "n2", expected: [], qualifiedSurfaced: [], falseSurfaced: [] }),
    ])
    expect(m.falsePositiveRate).toBeCloseTo(1 / 2)
    expect(m.abstentionRate).toBeCloseTo(1 / 2)
    expect(m.falsePositiveScenarios).toEqual(["n1"])
    expect(m.meanFalseHitsPerNegativeQuery).toBeCloseTo(0.5)
  })

  test("core-slot presence on a negative query is NOT a false positive (contractual always-on)", () => {
    const m = computeMetrics([
      result({ id: "n1", expected: [], qualifiedSurfaced: [], coreSurfaced: [3] }),
    ])
    expect(m.falsePositiveRate).toBe(0)
    expect(m.abstentionRate).toBe(1)
  })

  test("surface precision ignores the core slot but penalizes empty relevance tiers on positives", () => {
    const m = computeMetrics([
      result({ expected: [0, 4], qualifiedSurfaced: [0, 9], falseSurfaced: [9] }),
      result({ id: "empty", expected: [0], qualifiedSurfaced: [] }),
    ])
    expect(m.surfacePrecisionMacro).toBeCloseTo(((1 / 2) + 0) / 2)
  })
})
