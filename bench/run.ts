// Retrieval benchmark CLI. Run with: bun run bench
//
// Prints the metrics computed by the pure harness in bench/lib.ts over the
// scenario suite in bench/scenarios.ts.
//
//   bun run bench            -> full report
//   bun run bench --json     -> machine-readable JSON

import { allResults, computeMetrics, K, recallByTag, SURFACE } from "./lib.ts"

function fmt(x: number) {
  return (x * 100).toFixed(1).padStart(6) + "%"
}

const results = allResults()
const m = computeMetrics(results)

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        scenarios: m.scenarios,
        positives: m.positives,
        negatives: m.negatives,
        window: K,
        surface: SURFACE,
        recallAtK: m.recallAtK,
        mrr: m.mrr,
        surfacePrecision: m.surfacePrecision,
        falsePositiveRate: m.falsePositiveRate,
        falsePositiveScenarios: m.falsePositiveScenarios,
        abstentionRate: m.abstentionRate,
        meanFalseHitsPerNegativeQuery: m.meanFalseHitsPerNegativeQuery,
        overheadTokens: m.overheadTokens,
        recallByTag: recallByTag(results),
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

console.log(`Retrieval benchmark — ${m.scenarios} scenarios (${m.positives} positive / ${m.negatives} negative), window ${K}, surface ${SURFACE}\n`)

console.log("Candidate quality (full ranking, before the relevance gate):")
console.log(`  Recall@${K}:             ${fmt(m.recallAtK)}`)
console.log(`  MRR (first hit):     ${fmt(m.mrr)}`)
console.log("")
console.log("SURFACE quality (relevance tier actually injected):")
console.log(`  Surface precision:   ${fmt(m.surfacePrecision)}  (share of surfaced relevance entries that answer the query)`)
console.log("")
console.log("Negative scenarios (nothing relevant exists; can genuinely fail):")
console.log(`  False-positive rate: ${fmt(m.falsePositiveRate)}  (${m.falsePositiveScenarios.length}/${m.negatives} queries surfaced an irrelevant memory)`)
console.log(`  Abstention rate:     ${fmt(m.abstentionRate)}`)
if (m.falsePositiveScenarios.length > 0) {
  console.log(`  Failing scenarios:   ${m.falsePositiveScenarios.join(", ")}`)
}
console.log(`  Mean false hits:     ${m.meanFalseHitsPerNegativeQuery.toFixed(2)} per negative query`)
console.log("")
console.log(`Context overhead:      ${m.overheadTokens.toFixed(1)} tokens/query (mean, full block incl. core slot)\n`)

console.log("Recall@%d by scenario category (positives only):", K)
for (const [tag, v] of Object.entries(recallByTag(results))) {
  if (v > 0) console.log(`  ${tag.padEnd(20)} ${fmt(v)}`)
}
