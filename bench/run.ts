// Retrieval benchmark CLI. Run with: bun run bench
//
//   bun run bench                 -> full report on the DEVELOPMENT/REGRESSION set
//   bun run bench --heldout       -> report on the HELD-OUT evaluation set
//                                    (do not tune retrieval against it)
//   bun run bench --json          -> machine-readable metrics (same numbers)
//   bun run bench --json --heldout
//   bun run bench --explain-negatives [--fp-only] [--heldout]
//   bun run bench --explain-positives [--heldout]
//
// Metrics are computed ONCE by bench/lib.computeMetrics and rendered for
// humans and machines from the same object, so the outputs cannot diverge.

import {
  computeMetrics,
  explainScenario,
  K,
  recallByTag,
  runScenario,
  SURFACE,
  type ScenarioResult,
} from "./lib.ts"
import { HELDOUT_SCENARIOS } from "./scenarios-heldout.ts"
import { SCENARIOS } from "./scenarios.ts"

function fmt(x: number) {
  return (x * 100).toFixed(1).padStart(6) + "%"
}

function ci(i: { lo: number; hi: number }) {
  return `[${(i.lo * 100).toFixed(1)}%, ${(i.hi * 100).toFixed(1)}%]`
}

const args = process.argv.slice(2)
const heldout = args.includes("--heldout")
const setName = heldout ? "heldout" : "dev"

const results: ScenarioResult[] = (heldout ? HELDOUT_SCENARIOS : SCENARIOS).map((s) => runScenario(s))
const m = computeMetrics(results)

if (args.includes("--explain-negatives") || args.includes("--explain-positives")) {
  const wantNegatives = args.includes("--explain-negatives")
  const NEG = ["none", "hard-negative", "semantic-distractor", "xl-negative", "isolation-negative", "core-only"]
  const scenarios = (heldout ? HELDOUT_SCENARIOS : SCENARIOS).filter((s) =>
    wantNegatives ? s.expected.length === 0 || s.tags.some((tag) => NEG.includes(tag)) : true,
  )
  const rows = scenarios
    .flatMap(explainScenario)
    .filter((r) => (wantNegatives ? true : r.matches.some((x) => x.kind !== "exact" || !x.direct)))
    .filter((r) => (args.includes("--fp-only") ? r.isFalsePositive : true))
  console.log(JSON.stringify(rows, null, 2))
  process.exit(0)
}

if (args.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        set: setName,
        scenarios: m.scenarios,
        positives: m.positives,
        negatives: m.negatives,
        window: K,
        surface: SURFACE,
        recallAt1: m.recallAt1,
        recallAt5: m.recallAt5,
        mrr: m.mrr,
        surfacePrecisionMacro: m.surfacePrecisionMacro,
        surfacePrecisionMicro: m.surfacePrecisionMicro,
        surfacePrecisionCounts: { numer: m.surfacePrecisionNumer, denom: m.surfacePrecisionDenom },
        falseAbstentionRate: m.falseAbstentionRate,
        falseAbstentionScenarios: m.falseAbstentionScenarios,
        falsePositiveRate: m.falsePositiveRate,
        falsePositiveScenarios: m.falsePositiveScenarios,
        abstentionRate: m.abstentionRate,
        memoryLevelFalsePositives: m.memoryLevelFalsePositives,
        meanFalseHitsPerNegativeQuery: m.meanFalseHitsPerNegativeQuery,
        avgRelevanceTierPerQuery: m.avgRelevanceTierPerQuery,
        avgSurfacedPerQuery: m.avgSurfacedPerQuery,
        overheadTokens: m.overheadTokens,
        negativeBreakdown: {
          abstained: m.negativesAbstained,
          coreOnlySurfaced: m.negativesCoreOnlySurfaced,
          nonCoreSurfaced: m.negativesNonCoreSurfaced,
        },
        confidence95: m.confidence,
        recallByTag: recallByTag(results),
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

console.log(`Retrieval benchmark — ${setName.toUpperCase()} set: ${m.scenarios} scenarios (${m.positives} positive / ${m.negatives} negative), window ${K}, surface ${SURFACE}\n`)

console.log("Candidate quality (full ranking, before the relevance gate):")
console.log(`  Recall@1:            ${fmt(m.recallAt1)}`)
console.log(`  Recall@${K}:             ${fmt(m.recallAt5)}  95% CI ${ci(m.confidence.recallAt5)}`)
console.log(`  MRR (first hit):     ${fmt(m.mrr)}`)
console.log("")
console.log("SURFACE quality (relevance tier actually injected):")
console.log(`  Surface precision:   ${fmt(m.surfacePrecisionMacro)}  macro, mean per positive query`)
console.log(`    entry-level:       ${fmt(m.surfacePrecisionMicro)}  ${m.surfacePrecisionNumer}/${m.surfacePrecisionDenom} entries  95% CI ${ci(m.confidence.surfacePrecisionMicro)}`)
console.log(`  False abstentions:   ${fmt(m.falseAbstentionRate)}  (${m.falseAbstentionScenarios.length}/${m.positives} positives with empty relevance tier)`)
if (m.falseAbstentionScenarios.length > 0 && m.falseAbstentionScenarios.length <= 12) {
  console.log(`                       ${m.falseAbstentionScenarios.join(", ")}`)
}
console.log("")
console.log("Negative scenarios (nothing relevant exists; can genuinely fail):")
console.log(`  False-positive rate: ${fmt(m.falsePositiveRate)}  95% CI ${ci(m.confidence.falsePositiveRate)}`)
console.log(`  Abstention rate:     ${fmt(m.abstentionRate)}  95% CI ${ci(m.confidence.abstentionRate)}`)
console.log(`  Outcomes:            ${m.negativesAbstained} fully abstained / ${m.negativesCoreOnlySurfaced} core-slot only / ${m.negativesNonCoreSurfaced} surfaced irrelevant non-core`)
console.log(`  Memory-level FPs:    ${m.memoryLevelFalsePositives} entries (${m.meanFalseHitsPerNegativeQuery.toFixed(2)} per negative query)`)
if (m.falsePositiveScenarios.length > 0) {
  console.log(`  Failing scenarios:   ${m.falsePositiveScenarios.join(", ")}`)
}
console.log("")
console.log(`Context overhead:      ${m.overheadTokens.toFixed(1)} tokens/query (mean block incl. core slot)`)
console.log(`Avg surfaced/query:    ${m.avgSurfacedPerQuery.toFixed(2)} (relevance tier ${m.avgRelevanceTierPerQuery.toFixed(2)})\n`)

if (!heldout) {
  console.log(`Recall@${K} by scenario category (positives only):`)
  for (const [tag, v] of Object.entries(recallByTag(results))) {
    if (v > 0) console.log(`  ${tag.padEnd(20)} ${fmt(v)}`)
  }
}
