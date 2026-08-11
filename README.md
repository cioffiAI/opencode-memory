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
  reranking stage, relevance-gated surfacing
- **Retrieval feedback**: `memory_useful` / `memory_irrelevant` tune
  ranking from real usage
- **Per-memory privacy**: `local-only` facts never leave the machine
- Global and project-scoped memories, cross-language semantic deduplication
- Headless child-session consolidation with orphan GC and crash recovery

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
| `memory_read` | Search facts (query / category / scope) |
| `memory_write` | Store an explicit fact (`tier`, `ttlHours`, `pinned`, `sensitivity`) |
| `memory_update` | Correct a fact, by `id` or match — resolves CONFLICTED entries |
| `memory_forget` / `memory_clear` | Remove facts |
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

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `OPENCODE_MEMORY_OFF` | off | `1` disables the plugin. |
| `OPENCODE_MEMORY_DIR` | `~/.local/share/opencode/memory` | Data directory (store/state/summary). |
| `OPENCODE_MEMORY_DEBUG` | off | `1` enables trace logging. |
| `OPENCODE_MEMORY_DELAY_MS` | 90000 | Debounce of consolidation after session idle (3s in tests). |
| `OPENCODE_MEMORY_RERANK` | off | `1` enables the semantic reranking stage (headless LLM rerank of the candidate window; cached per query, falls back to lexical order on timeout). |
| `OPENCODE_MEMORY_RERANK_CANDIDATES` | 30 | Candidate window handed to the reranker. |
| `OPENCODE_MEMORY_RERANK_TIMEOUT_MS` | 4000 | Rerank timeout before lexical fallback. |
| `OPENCODE_MEMORY_RERANK_CACHE_MS` | 60000 | Per-query rerank cache lifetime. |
| `OPENCODE_MEMORY_CORE_SLOT` | 3 | Core-tier entries always injected beyond relevance matches. |
| `OPENCODE_MEMORY_SURFACE_REFRESH_MS` | 900000 | Surfaced memories refresh `lastSeen` at most once per interval. |
| `OPENCODE_MEMORY_GC_CHILD_AGE_MS` | 600000 | Min age of an orphan child session before auto-removal. |
| `OPENCODE_MEMORY_INPROGRESS_TIMEOUT_MS` | 600000 | Expiry of the `inProgress` marker (crash recovery). |

## Retrieval benchmark

`bun run bench` runs the scenario suite (90 cases: paraphrase, IT/EN
cross-language, synonyms, distractors, contradictions, duplicates, project
isolation, obsolete facts, false positives, no-match queries):

```text
Recall@5:         100.0%  (expected memories found / expected)
Precision@5:       20.8%  (max attainable for this suite: 20.8%)
MRR (first hit):    95.0%
False-surface rate:  0.0%  (unsupported surfacing on 'should be empty' cases)
Context overhead:   13.8 tokens/query (mean, surface 8)
```

## Privacy

Memory files are always stored locally (JSON + lockfile, no external database,
no plugin cloud service).

During DREAM consolidation, the conversation is processed by the model provider
configured in OpenCode. That provider may be local (e.g. Ollama) or remote (a
cloud API): if remote, conversation text is sent to that provider through the
same channels OpenCode already uses. For sensitive data, use a local provider
or set `OPENCODE_MEMORY_OFF=1`.

Facts written with `sensitivity: "local-only"` are never included in the
memory block of any prompt (so they never reach a remote provider) and never
included in consolidation prompts; they are only accessible through
`memory_read`.

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
