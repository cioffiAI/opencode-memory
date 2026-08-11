// Retrieval benchmark. Run with: bun run bench
//
// Measures the pure lexical pipeline (retrieve + core slot) against the
// scenario suite in bench/scenarios.ts and prints publishable numbers:
// Recall@5, Precision@5, MRR, false-surface rate and context overhead.
//
//   bun run bench            -> full report
//   bun run bench --json     -> machine-readable JSON

import { coreSlot, CORE_CATEGORIES, retrieve, type Entry, type Store } from "../src/core.ts"
import { SCENARIOS } from "./scenarios.ts"

const DAY = 24 * 60 * 60 * 1000
const K = 5
const SURFACE = 8

const t = Date.now()

function buildStore(memories: typeof SCENARIOS[number]["memories"]): Store {
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
      status: "ACTIVE",
      sensitivity: "normal",
      helpfulCount: m.helpful,
      irrelevantCount: m.irrelevant,
    })
  })
  return store
}

type ScenarioResult = {
  id: string
  tags: string[]
  expected: number[]
  retrieved: number[]
  rankFirst: number
  surfaced: number
  falseSurfaced: number
  chars: number
}

function runScenario(scenario: (typeof SCENARIOS)[number]): ScenarioResult {
  const store = buildStore(scenario.memories)
  const ranked = retrieve(store, scenario.directory, scenario.query, t, { candidateCount: 30 })
  const top = ranked.slice(0, K)
  const retrieved = top.filter((r) => scenario.expected.includes(Number(r.entry.id.slice(1)))).map((r) => Number(r.entry.id.slice(1)))
  const idxOf = new Map(ranked.map((r, i) => [r.entry.id, i]))
  const firstExpected = scenario.expected.map((e) => idxOf.get(`m${e}`) ?? Infinity).sort((a, b) => a - b)[0]
  const rankFirst = firstExpected === Infinity ? 0 : firstExpected + 1
  // Surfacing simulation, mirroring buildMemoryBlock: only keyword-qualified
  // entries enter the relevance tier; everything else is core-slot only.
  const qualified = ranked.filter((r) => r.keywordHits > 0).slice(0, SURFACE)
  const qualifiedIds = new Set(qualified.map((r) => r.entry.id))
  const core = coreSlot(store, scenario.directory, qualifiedIds, t, 3)
  const surfaced = [...qualified, ...core.map((e) => ({ entry: e, base: 0, keywordHits: 0, core: true, rank: 0, final: 0 }))]
  const chars = surfaced.reduce((a, r) => a + r.entry.text.length, 0)
  // False surfacing = surfaced without keyword support AND without a
  // design justification (core tier / pinned / explicit always-on).
  const falseSurfaced = surfaced.filter((r) => r.keywordHits === 0 && !r.core && r.entry.tier !== "core" && !r.entry.pinned).length
  return {
    id: scenario.id,
    tags: scenario.tags,
    expected: scenario.expected,
    retrieved,
    rankFirst,
    surfaced: surfaced.length,
    falseSurfaced,
    chars,
  }
}

function fmt(x: number) {
  return x.toFixed(1).padStart(6) + "%"
}

const results = SCENARIOS.map(runScenario)

const withExpected = results.filter((r) => r.expected.length > 0)
const recall = withExpected.map((r) => r.retrieved.length / r.expected.length)
const precision = withExpected.map((r) => r.retrieved.length / K)
const mrr = withExpected.map((r) => (r.rankFirst > 0 ? 1 / r.rankFirst : 0))
const noExpected = results.filter((r) => r.expected.length === 0)
const falseSurface = noExpected.map((r) => r.falseSurfaced / SURFACE)
const overhead = withExpected.map((r) => r.chars / 4)
const maxPrecision = mean(withExpected.map((r) => r.expected.length / K))

function mean(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
}

function byTag(tag: string) {
  const g = withExpected.filter((r) => r.tags.includes(tag))
  return mean(g.map((r) => r.retrieved.length / r.expected.length))
}

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        scenarios: SCENARIOS.length,
        recallAt5: mean(recall),
        precisionAt5: mean(precision),
        mrr: mean(mrr),
        falseSurfaceRate: mean(falseSurface),
        overheadTokens: mean(overhead),
        byTag: Object.fromEntries(
          [...new Set(SCENARIOS.flatMap((s) => s.tags))].map((tag) => [tag, byTag(tag)]),
        ),
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

console.log(`Retrieval benchmark — ${SCENARIOS.length} scenarios, window ${K}, surface ${SURFACE}\n`)
console.log(`Recall@${K}:          ${fmt(mean(recall) * 100)}  (expected memories found / expected)`)
console.log(`Precision@${K}:       ${fmt(mean(precision) * 100)}  (max attainable for this suite: ${fmt(maxPrecision * 100)})`)
console.log(`MRR (first hit):      ${(mean(mrr) * 100).toFixed(1).padStart(6)}%`)
console.log(`False-surface rate:   ${fmt(mean(falseSurface) * 100)}  (unsupported surfacing on 'should be empty' cases)`)
console.log(`Context overhead:     ${mean(overhead).toFixed(1).padStart(6)} tokens/query (mean, surface ${SURFACE})`)
console.log("")
console.log("Recall@5 by failure mode:")
for (const tag of [...new Set(SCENARIOS.flatMap((s) => s.tags))]) {
  console.log(`  ${tag.padEnd(14)} ${fmt(byTag(tag) * 100)}`)
}
console.log("")
console.log("Worst scenarios (recall miss or unsupported surfacing):")
const misses = results
  .filter((r) => r.retrieved.length < r.expected.length || r.falseSurfaced > 0)
  .sort((a, b) => b.falseSurfaced - a.falseSurfaced)
for (const r of misses.slice(0, 12)) {
  if (r.expected.length === 0) {
    console.log(`  ${r.id.padEnd(10)} [none|surface] unsupported surfaced ${r.falseSurfaced}/${SURFACE}`)
  } else {
    console.log(`  ${r.id.padEnd(10)} [${r.tags.join(",")}] expected [${r.expected}] got [${r.retrieved}] rank#${r.rankFirst}`)
  }
}
if (misses.length === 0) console.log("  (no misses)")
