# opencode-memory

<video src="https://github.com/user-attachments/assets/b3b06cb6-0b63-4b18-a401-37964fe9e322" controls muted></video>

Local-first persistent memory for OpenCode.

opencode-memory gives OpenCode durable memory across sessions through a
WRITE → DREAM → SURFACE lifecycle:

- WRITE: explicit memory tools
- DREAM: headless conversation consolidation
- SURFACE: selective memory injection into future prompts

## Features

- Local JSON storage with file locking
- Explicit and inferred memory hierarchy
- Cross-language semantic deduplication
- Global and project-scoped memories
- Selective topic-aware retrieval
- Headless child-session consolidation
- Orphan child-session garbage collection
- No external database

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

The plugin works without `/memory`: the `memory_read`, `memory_write`,
`memory_update`, `memory_forget` and `memory_clear` tools and the automatic
DREAM cycle are registered directly by the plugin.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `OPENCODE_MEMORY_OFF` | off | `1` disables the plugin. |
| `OPENCODE_MEMORY_DIR` | `~/.local/share/opencode/memory` | Data directory (store/state/summary). |
| `OPENCODE_MEMORY_DEBUG` | off | `1` enables trace logging. |
| `OPENCODE_MEMORY_DELAY_MS` | 90000 | Debounce of consolidation after session idle (3s in tests). |
| `OPENCODE_MEMORY_GC_CHILD_AGE_MS` | 600000 | Min age of an orphan child session before auto-removal. |
| `OPENCODE_MEMORY_INPROGRESS_TIMEOUT_MS` | 600000 | Expiry of the `inProgress` marker (crash recovery). |

## Privacy

Memory files are always stored locally (JSON + lockfile, no external database,
no plugin cloud service).

During DREAM consolidation, the conversation is processed by the model provider
configured in OpenCode. That provider may be local (e.g. Ollama) or remote (a
cloud API): if remote, conversation text is sent to that provider through the
same channels OpenCode already uses. For sensitive data, use a local provider
or set `OPENCODE_MEMORY_OFF=1`.

## Development

```bash
bun install
bun run check   # typecheck + tests + build
npm pack --dry-run
```

## License

MIT — see [LICENSE](LICENSE).
