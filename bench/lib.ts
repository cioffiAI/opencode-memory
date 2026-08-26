// Pure evaluation harness for the retrieval benchmark (no CLI output).
//
// Methodology — every metric corresponds to an independently meaningful
// property, and negative scenarios can genuinely fail:
//
//   Candidate quality (independent of the surfacing gate):
//     Recall@K   — share of expected memories present in the top-K of the
//                  full ranking, before any keyword gating.
//     MRR        — reciprocal rank of the first expected memory.
//
//   SURFACE quality (the actual injected block):
//     Surface precision — share of RELEVANCE-TIER surfaced entries that are
//                  expected. Core-slot entries are excluded from both sides:
//                  the product contract surfaces core memories
//                  unconditionally, so they can be neither credited as hits
//                  nor counted as false positives.
//
//   False positives / abstention (negative scenarios, expected = []):
//     FP rate    — share of negative queries where at least one relevance-tier
//                  entry was surfaced. This is falsifiable: a hard negative
//                  sharing lexical material with an irrelevant memory fails.
//     Abstention — 1 − FP rate: negative queries where the relevance tier
//                  stayed empty.
//
//   Context overhead — mean tokens (chars/4) of the full simulated block.

import { coreSlot, CORE_CATEGORIES, retrieve, type Entry, type Store } from "../src/core.ts"
import { NEGATIVE_TAGS, SCENARIOS, type Scenario } from "./scenarios.ts"

export const K = 5
export const SURFACE = 8

export { SCENARIOS, NEGATIVE_TAGS }
export type { Scenario }

const DAY = 24 * 60 * 60 * 1000
const t = Date.now()

export function buildStore(memories: Scenario["memories"]): Store {
  const store: Store = { version: 2, summary: "", updatedAt: t, entries: [] }
  memories.forEach((m, i) => {
    const tierEntry = (CORE_CATEGORIES.has(m.category ?? "other") ? "core" : "archival") as Entry["tier"]
    const lastSeen = t - (m.lastSeenAgoDays ?? 0) * DAY
    store.entries.push({
      id: `m${i}`,
      text: m.text,
      category: m.category ?? "other",
      scope: m.scope ?? "global",
      projectID: m.scope === "project" ? m.projectID : undefined,
      weight: m.weight ?? 2,
      created: lastSeen,
      lastSeen,
      source: "dreamed",
      tier: tierEntry,
      status: m.status ?? "ACTIVE",
      sensitivity: "normal",
      pinned: m.pinned,
      helpfulCount: m.helpful,
      irrelevantCount: m.irrelevant,
    })
  })
  return store
}

export type ScenarioResult = {
  id: string
  tags: string[]
  expected: number[]
  /** indices of expected memories found in the top-K of the full ranking */
  retrieved: number[]
  /** 1-based rank of the first expected memory in the FULL ranking; 0 if absent */
  rankFirst: number
  /** relevance-tier surface: indices actually surfaced through relevance */
  qualifiedSurfaced: number[]
  /** core-slot indices (contractually always-on; not scored) */
  coreSurfaced: number[]
  /** relevance-tier surfaced indices that are NOT expected */
  falseSurfaced: number[]
  chars: number
}

export function isNegative(scenario: Scenario): boolean {
  return scenario.expected.length === 0 || scenario.tags.some((tag) => NEGATIVE_TAGS.has(tag))
}

export function runScenario(scenario: Scenario): ScenarioResult {
  const store = buildStore(scenario.memories)
  const ranked = retrieve(store, scenario.directory, scenario.query, t, { candidateCount: 30 })

  const top = ranked.slice(0, K)
  const retrieved = [...new Set(top.filter((r) => scenario.expected.includes(Number(r.entry.id.slice(1)))).map((r) => Number(r.entry.id.slice(1))))]

  // rank of the first expected hit within the FULL candidate ranking
  let rankFirst = 0
  for (let i = 0; i < ranked.length && rankFirst === 0; i++) {
    if (scenario.expected.includes(Number(ranked[i].entry.id.slice(1)))) rankFirst = i + 1
  }

  // Surfacing simulation mirroring buildMemoryBlock: without RERANK only
  // keyword-qualified entries enter the relevance tier; the core slot fills
  // up to its budget with contractually always-on memories.
  const qualified = ranked.filter((r) => r.keywordHits > 0).slice(0, SURFACE)
  const qualifiedIds = new Set(qualified.map((r) => r.entry.id))
  const core = coreSlot(store, scenario.directory, qualifiedIds, t, 3)

  const idx = (e: Entry) => Number(e.id.slice(1))
  const qualifiedSurfaced = qualified.map((r) => idx(r.entry))
  const coreSurfaced = core.map(idx)
  const falseSurfaced = qualifiedSurfaced.filter((i) => !scenario.expected.includes(i))
  const chars = [...qualified, ...core.map((e) => ({ entry: e }))].reduce((a, r) => a + r.entry.text.length, 0)

  return {
    id: scenario.id,
    tags: scenario.tags,
    expected: scenario.expected,
    retrieved,
    rankFirst,
    qualifiedSurfaced,
    coreSurfaced,
    falseSurfaced,
    chars,
  }
}

export type Metrics = {
  scenarios: number
  positives: number
  negatives: number
  recallAtK: number
  mrr: number
  surfacePrecision: number
  falsePositiveRate: number
  falsePositiveScenarios: string[]
  abstentionRate: number
  meanFalseHitsPerNegativeQuery: number
  overheadTokens: number
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

export function computeMetrics(results: ScenarioResult[]): Metrics {
  const positives = results.filter((r) => r.expected.length > 0)
  const negatives = results.filter((r) => r.expected.length === 0)

  const recallAtK = mean(positives.map((r) => r.retrieved.length / Math.max(1, r.expected.length)))
  const mrr = mean(positives.map((r) => (r.rankFirst > 0 ? 1 / r.rankFirst : 0)))
  // Surface precision over positives: relevance-tier entries that were
  // expected. A positive whose relevance tier is empty counts as 0 (miss).
  const surfacePrecision = mean(
    positives.map((r) => {
      const good = r.qualifiedSurfaced.filter((i) => r.expected.includes(i)).length
      return good / Math.max(1, r.qualifiedSurfaced.length)
    }),
  )

  const fpScenarios = negatives.filter((r) => r.falseSurfaced.length > 0)
  const falsePositiveRate = negatives.length === 0 ? 0 : fpScenarios.length / negatives.length
  const totalFalseHits = negatives.reduce((a, r) => a + r.falseSurfaced.length, 0)

  return {
    scenarios: results.length,
    positives: positives.length,
    negatives: negatives.length,
    recallAtK,
    mrr,
    surfacePrecision,
    falsePositiveRate,
    falsePositiveScenarios: fpScenarios.map((r) => r.id),
    abstentionRate: 1 - falsePositiveRate,
    meanFalseHitsPerNegativeQuery: negatives.length === 0 ? 0 : totalFalseHits / negatives.length,
    overheadTokens: mean(results.map((r) => r.chars / 4)),
  }
}

export function recallByTag(results: ScenarioResult[]): Record<string, number> {
  const tags = [...new Set(SCENARIOS.flatMap((s) => s.tags))]
  const out: Record<string, number> = {}
  for (const tag of tags) {
    const group = results.filter((r) => r.tags.includes(tag) && r.expected.length > 0)
    out[tag] = mean(group.map((r) => r.retrieved.length / Math.max(1, r.expected.length)))
  }
  return out
}

export function allResults(): ScenarioResult[] {
  return SCENARIOS.map(runScenario)
}
