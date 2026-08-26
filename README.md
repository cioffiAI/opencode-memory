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
| `memory_read` | Search facts (query / category / scope); global + current project only |
| `memory_write` | Store an explicit fact (`tier`, `ttlHours`, `pinned`, `sensitivity`) |
| `memory_update` | Correct a fact, by `id` or match — resolves CONFLICTED entries |
| `memory_forget` / `memory_clear` | Remove facts (scoped to what is visible in this project) |
| `memory_why` | Audit a memory: provenance, lifecycle, score breakdown |
| `memory_inspect` | `stats` \| `recent` \| `conflicts` \| `project` \| `surfaced` |
| `memory_useful` / `memory_irrelevant` | Feedback on retrieval quality |

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

## Retrieval benchmark

`bun run bench` runs the scenario suite (115 scenarios: 77 positive, 38
negative) through the pure harness in `bench/lib.ts`. Every metric measures an
independently meaningful property, and negative scenarios can genuinely fail:

- **Candidate quality** (full ranking, before any gating): Recall@5 and MRR.
- **SURFACE quality**: precision of the relevance tier actually injected
  (core-slot entries are excluded from both sides — they are contractually
  always-on).
- **False-positive rate**: share of negative queries (clean no-match, hard
  negatives sharing lexical terms, semantically adjacent distractors,
  cross-language collisions, project-isolation negatives, core-only queries)
  where at least one irrelevant entry entered the relevance tier.
  **Abstention rate** = 1 − FP rate.
- **Context overhead**: mean tokens of the full simulated block.

Current numbers (lexical pipeline, reranker disabled):

```text
Recall@5:            100.0%
MRR (first hit):      95.2%
Surface precision:    65.8%
False-positive rate:  39.5%  (15/38 negative queries)
Abstention rate:      60.5%
Context overhead:     9.5 tokens/query
```

Interpretation: candidate quality is high, but the purely lexical stage has
real limitations, now measured instead of hidden:

- Queries whose relevant memory shares NO content word (true paraphrase,
  much of the cross-language suite) correctly pass nothing into the relevance
  tier — surface precision counts those as misses. Enable
  `OPENCODE_MEMORY_RERANK=1` for semantic rescue of these cases.
- Hard negatives sharing lexical material ("test", "database", "server",
  "security"…) can still surface an irrelevant memory (39.5% FP rate on
  negative queries). This is the known ceiling of keyword retrieval without
  embeddings; the optional reranker with abstention is the mitigation path.

Positive scenarios were frozen before this release and are not tuned against
the synonym table; negatives are designed against the product contract, not
the implementation.

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
bun run check   # typecheck + tests + build
bun run bench   # retrieval benchmark
npm pack --dry-run
```

## License

MIT — see [LICENSE](LICENSE).
