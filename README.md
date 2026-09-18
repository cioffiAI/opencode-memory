# opencode-memory

<video src="https://github.com/user-attachments/assets/b3b06cb6-0b63-4b18-a401-37964fe9e322" controls muted></video>

Local-first persistent memory for OpenCode.

opencode-memory gives OpenCode durable memory across sessions through a
WRITE → DREAM → SURFACE lifecycle:

- WRITE: explicit memory tools
- DREAM: headless conversation consolidation
- SURFACE: selective memory injection into future prompts

## Features

- Local JSON storage with file locking, **zero external database**
- Explicit and inferred memory hierarchy with **auditable provenance**
  (each dreamed fact knows its source session, messages and confidence)
- **Memory Inspector**: `/memory` stats, conflicts, "why was this surfaced"
- **Contradiction lifecycle**: CONFLICTED explicit facts are flagged and
  resolved, never silently overwritten
- **Memory tiers**: core (always surfaced) / archival (on relevance) /
  temporary (auto-expiry) / pinned (never decays)
- **Hybrid retrieval**: lexical keyword pipeline + optional semantic
  reranking stage with abstention, relevance-gated surfacing
- **Retrieval feedback**: `memory_useful` / `memory_irrelevant` tune
  ranking from real usage
- **Per-memory privacy**: `local-only` facts stay on disk, out of every
  model-visible path (see [Privacy](#privacy) for the exact threat model)
- Global and project-scoped memories with enforced per-directory isolation,
  cross-language semantic deduplication
- Headless child-session consolidation running with **zero tools**
  (allow-none), orphan GC and crash recovery

## Project scope semantics

A project-scoped memory belongs to exactly one project directory
(`projectID` = the OpenCode session directory). The rules, enforced by a
single policy in `src/core.ts` (`projectVisible`, `readableEntries`,
`consolidationEntries`, `readQuery`) and covered by regression tests:

- Every model-facing tool (`memory_read`, `memory_update`, `memory_forget`,
  `memory_why`, `memory_useful`, `memory_irrelevant`, `memory_inspect`) sees
  global entries plus the CURRENT project's entries — never another
  project's.
- `memory_write` rewrite-dedup targets only an entry in the same scope (and
  the same project). A global fact and an equivalent project fact may coexist;
  neither suppresses the other. In that project both are retrievable,
  elsewhere only the global one.
- `memory_clear` with `scope: "project"` removes ONLY the current project's
  memories; other projects keep theirs. Without a scope it wipes everything
  (all projects, including local-only entries).
- DREAM consolidation for a session in project A can never suppress, merge
  with, rewrite, supersede or flag entries of project B (or local-only
  entries), even if the consolidation output references their ids.

## Installation

Add the package to your OpenCode configuration (`~/.config/opencode/opencode.json`
or `opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@cioffi_ai/opencode-memory"
  ]
}
```

OpenCode installs npm plugins automatically via Bun on startup and caches them
in `~/.cache/opencode/node_modules/`. Restart OpenCode after adding the entry.

### Optional: `/memory` command

The npm package does not copy `commands/memory.md` into your user directory
(plugin package installs do not run lifecycle scripts). To enable the `/memory`
command, copy it manually from this repository:

```bash
mkdir -p ~/.config/opencode/commands

curl -o ~/.config/opencode/commands/memory.md \
  https://raw.githubusercontent.com/cioffiAI/opencode-memory/main/commands/memory.md
```

The plugin works without `/memory`: the tools are registered directly by the
plugin, and the automatic DREAM cycle runs regardless.

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_read` | Search facts (query / category / scope); multi-word queries match all terms; global + current project only |
| `memory_write` | Store an explicit fact (`tier`, `ttlHours`, `pinned`, `sensitivity`) |
| `memory_update` | Correct a fact, by `id` or match — resolves CONFLICTED entries |
| `memory_forget` / `memory_clear` | Remove facts (scoped to what is visible in this project) |
| `memory_why` | Audit a memory: provenance, lifecycle, score breakdown |
| `memory_inspect` | `stats` \| `recent` \| `conflicts` \| `project` \| `surfaced` |
| `memory_useful` / `memory_irrelevant` | Feedback on retrieval quality |

`memory_read` uses its own conservative lexical search: the historical
contiguous substring match is preserved, plus an all-terms path where every
term of a multi-word query must appear as a whole token (any order,
non-contiguous) in the text or category. Short and technical terms are kept
(`AI`, `UI`, `DB`, `C`, `R`, `no`, `C++`, `C#`, `Node.js`, `.NET`); no
stemming, synonyms or accent folding. Scope/category filters, score ordering
and privacy rules are identical to the rest of the plugin.

Example of `memory_why`:

```text
Text:    The user prefers Bun over npm.
Source:  explicit (via memory_write)
Lifecycle: ACTIVE | tier core | pinned (no decay)
Score (now): 3.512 = (3.00 + source bonus + utilization) × decay 1.000
Last surfacing (session abc):
  Base score:   3.51
  Keyword match: +3.00 (1 hits)
  Core bonus:    yes
  Final rank:    #2
```

## Recency, exposure and feedback

Time-based decay is computed from `lastSeen` — the last time a fact was
CONFIRMED (explicit write/update, consolidation refresh, or positive feedback
via `memory_useful`). Automatic surfacing updates only exposure counters
(`lastSurfaced`, `surfacedCount`): being shown to the model is not evidence
that a fact is still true, so exposure never resets decay and cannot make a
frequently-surfaced memory immortal under pruning. Negative feedback
(`memory_irrelevant`) lowers ranking without touching recency.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `OPENCODE_MEMORY_OFF` | off | `1` disables the plugin. |
| `OPENCODE_MEMORY_DIR` | `~/.local/share/opencode/memory` | Data directory (store/state/summary). |
| `OPENCODE_MEMORY_DEBUG` | off | `1` enables trace logging. |
| `OPENCODE_MEMORY_DELAY_MS` | 90000 | Debounce of consolidation after session idle (3s in tests). |
| `OPENCODE_MEMORY_RERANK` | off | `1` enables the semantic reranking stage (headless LLM rerank of the candidate window; cached per query; may ABSTAIN; falls back to lexical order on timeout). |
| `OPENCODE_MEMORY_RERANK_CANDIDATES` | 30 | Candidate window handed to the reranker. |
| `OPENCODE_MEMORY_RERANK_TIMEOUT_MS` | 4000 | Rerank timeout before lexical fallback. |
| `OPENCODE_MEMORY_RERANK_CACHE_MS` | 60000 | Per-query rerank cache lifetime. |
| `OPENCODE_MEMORY_CORE_SLOT` | 3 | Core-tier entries always injected beyond relevance matches. |
| `OPENCODE_MEMORY_SURFACE_REFRESH_MS` | 900000 | Min interval between two exposure-counter updates for the same entry. |
| `OPENCODE_MEMORY_GC_CHILD_AGE_MS` | 600000 | Min age of an orphan child session before auto-removal. |
| `OPENCODE_MEMORY_INPROGRESS_TIMEOUT_MS` | 600000 | Expiry of the `inProgress` marker (crash recovery). |

## Retrieval semantics (v1.6)

The lexical pipeline is a small, independently testable chain:

tokenizer → keyword extraction → alias expansion → candidate generation
(scope/status/sensitivity filter) → boundary-safe matching → scoring →
**relevance gate** → surface (+ optional semantic rerank with abstention).

Matching rules, enforced in `src/core.ts` and covered by regression tests:

- **Token boundaries are sacred.** A keyword matches whole normalized tokens
  only. `use` never matches `user`, `test` never matches `pytest`/
  `greatest`, `red` never matches `redesign`. Bare substring and open-ended
  prefix matching were removed in v1.6.
- **Identifiers are first-class.** camelCase/PascalCase split at case
  boundaries (`userStore` → `user` + `store`); snake_case, kebab-case,
  dotted names and paths split on their separators. Both the whole compound
  (`javascript`) and its parts match.
- **Morphology is explicit and small**: plural (`deploy`↔`deploys`), gerund
  (`network`↔`networking`) and participle (`test`↔`tested`) forms match in
  both directions. Nothing else.
- **Synonym groups contain only substitutable terms** (translations,
  aliases, abbreviations of the SAME concept: `colore`↔`color`,
  `job`↔`lavoro`, `db`↔`database`). Opinion verbs (`like`, `prefer`,
  `favorite`…) are not synonyms of anything and no longer bridge domains.
- The **relevance gate** is a named single-source predicate
  (`passesRelevanceGate`): candidates without at least one boundary-safe
  match never enter the injected block; the core slot stays contractual.
- Every surfacing decision is explainable: `retrieve()` returns per-keyword
  provenance (`keyword:kind via query-term`), and
  `bun run bench --explain-negatives` dumps it machine-readably.

## Retrieval benchmark

Two scenario sets, one harness (`bench/lib.ts`):

- **DEV/REGRESSION set** (115 scenarios: 77 positive / 38 negative across six
  negative categories) — used while developing; its positives are frozen
  since v1.5.0 and must never be edited to flatter the algorithm.
- **HELD-OUT set** (20 scenarios) — written once from the feature contract
  BEFORE the v1.6 fixes were implemented and not iterated against. It
  includes identifier/package-name/path traps, bilingual weak associations,
  related-tech-wrong-fact and declared CEILING-MEASURE cases.

Metrics (identical in human and `--json` output): Recall@1, Recall@5, MRR
(candidate quality, before any gate), macro and entry-level surface
precision, false-abstention rate on positives, query-level false-positive
rate with memory-level counts, abstention breakdown for negatives (fully
abstained / core-slot only / irrelevant non-core surfaced), Wilson 95%
confidence intervals, average surfaced memories and context overhead.

Current results (lexical pipeline, reranker disabled):

```text
DEV set     Recall@5 100% · MRR 95.2% · surface precision 63.2% macro /
            81.8% entry-level (54/66) · FPR 34.2% (13/38) · overhead 9.1 tok
HELD-OUT    Recall@5 100% · MRR 100%  · FPR 26.7% (4/15) · 0 false abstentions
            (v1.5.1 algorithm measured on the same held-out set: FPR 46.7%,
             7/15, including every identifier/substring trap)
```

Interpretation: all remaining negative-scenario failures are exact-token or
true-translation matches whose INTENT differs ("test account" vs test
framework question, "server in the basement" vs MCP server configuration,
relational facts like "the brother repairs phones"). No mechanical matching
bug remains in either set. This is the honest ceiling of zero-dependency
lexical retrieval; the mitigation path already shipped is the optional
semantic reranker with abstention (`OPENCODE_MEMORY_RERANK=1`). Embeddings
are NOT yet justified by this evidence: the residual errors are intent/attribution
problems, which bag-of-embeddings only partially addresses.

## Privacy

Memory files are always stored locally (JSON + lockfile, no external database,
no plugin cloud service).

During DREAM consolidation, the conversation transcript is processed by the
model provider configured in OpenCode. That provider may be local (e.g.
Ollama) or remote (a cloud API): if remote, conversation text is sent to that
provider through the same channels OpenCode already uses — this plugin cannot
change that. For sensitive conversations use a local provider or set
`OPENCODE_MEMORY_OFF=1`.

### `local-only` memories: exact guarantee

Facts written with `sensitivity: "local-only"` are stored on disk only. The
plugin never includes them in ANY model-visible path:

- not in the automatic `<memory>` block (SURFACE injection),
- not among DREAM prompt entries nor the semantic dedup prompt,
- not among semantic rerank candidates,
- not returned by `memory_read`, `memory_why` or any `memory_inspect` view,
- not mutable through `memory_update`, `memory_forget`, `memory_useful`,
  `memory_irrelevant` (they are invisible to all of them).

They are therefore inaccessible to the model in every later session; the only
supported access path is direct file inspection by the human user
(`store.json` / `SUMMARY.md` in `OPENCODE_MEMORY_DIR`). Use them as a durable
local record of secrets that must never propagate to new contexts.

Two limitations remain, by architecture rather than by omission:

1. The WRITE call itself necessarily passes through the model (it is a tool
   call), and if the fact was typed in the conversation, the transcript has
   already reached the provider. `local-only` prevents RE-exposure in future
   sessions; it cannot retract what already left the machine.
2. The generated summary is derived from the transcript by the provider; the
   DREAM prompt forbids sensitive data in summaries, but the plugin cannot
   technically guarantee what a remote model writes there.

## DREAM containment

Consolidation, semantic dedup and semantic rerank run in headless child
sessions that process untrusted conversation text. Those sessions are created
with a single wildcard tool denial (`tools: { "*": false }`), which — verified
against the OpenCode server source (v1.18.0 through v1.18.20) — removes ALL
tools from the model-visible toolset: shell execution, file editing, network
fetch, MCP tools, subagents, memory tools, and tools contributed by any other
plugin. The child receives only the textual prompt and returns text; it cannot
execute side effects. Crash recovery (inProgress markers), orphan GC and
at-least-once consolidation semantics are unaffected.

## Roadmap

- **2.0**: shared / agent-scoped memory, graph memory with entity
  relationships, encrypted multi-device sync, import/export.

## Development

```bash
bun install
bun run check           # typecheck + tests + build
bun run verify:package  # build + pack + isolated install + tool assertion
bun run bench           # retrieval benchmark
npm pack --dry-run
```

## License

MIT — see [LICENSE](LICENSE).
