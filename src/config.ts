// Plugin configuration and well-known paths, split out of index.ts so tests
// can import constants (e.g. the child-session tool containment contract)
// without loading the OpenCode plugin runtime.

export const CONSOLIDATION_TITLE = "memory-consolidation"
export const RERANK_TITLE = "memory-surfacing"

export const CONFIG = {
  off: process.env.OPENCODE_MEMORY_OFF === "1",
  debug: process.env.OPENCODE_MEMORY_DEBUG === "1",
  delayMs: Number(process.env.OPENCODE_MEMORY_DELAY_MS ?? 90000),
  maxEntries: Number(process.env.OPENCODE_MEMORY_MAX_ENTRIES ?? 400),
  maxFacts: Number(process.env.OPENCODE_MEMORY_MAX_FACTS ?? 18),
  maxChars: Number(process.env.OPENCODE_MEMORY_MAX_CHARS ?? 2400),
  transcriptChars: Number(process.env.OPENCODE_MEMORY_TRANSCRIPT_CHARS ?? 12000),
  sweepIntervalMs: Number(process.env.OPENCODE_MEMORY_SWEEP_MS ?? 10 * 60 * 1000),
  sweepStartMs: Number(process.env.OPENCODE_MEMORY_SWEEP_START_MS ?? 20000),
  sweepBatch: Number(process.env.OPENCODE_MEMORY_SWEEP_BATCH ?? 8),
  gcChildAgeMs: Number(process.env.OPENCODE_MEMORY_GC_CHILD_AGE_MS ?? 10 * 60 * 1000),
  inProgressTimeoutMs: Number(process.env.OPENCODE_MEMORY_INPROGRESS_TIMEOUT_MS ?? 10 * 60 * 1000),
  // Hybrid retrieval: optional semantic reranking stage. Off by default;
  // when enabled it reranks the lexical candidate window through a headless
  // LLM call, cached per query and bounded by a timeout that falls back to
  // the lexical order on any delay. The reranker may ABSTAIN ({"order":[]});
  // abstention surfaces nothing beyond the core slot.
  rerank: process.env.OPENCODE_MEMORY_RERANK === "1",
  rerankCandidates: Number(process.env.OPENCODE_MEMORY_RERANK_CANDIDATES ?? 30),
  rerankTimeoutMs: Number(process.env.OPENCODE_MEMORY_RERANK_TIMEOUT_MS ?? 4000),
  rerankCacheMs: Number(process.env.OPENCODE_MEMORY_RERANK_CACHE_MS ?? 60 * 1000),
  coreSlot: Number(process.env.OPENCODE_MEMORY_CORE_SLOT ?? 3),
  // Surface exposure bookkeeping is persisted at most once per entry per
  // interval to avoid IO on every prompt. Exposure never refreshes recency.
  surfaceRefreshMs: Number(process.env.OPENCODE_MEMORY_SURFACE_REFRESH_MS ?? 15 * 60 * 1000),
}

import path from "path"
import os from "os"

export const DATA_DIR =
  process.env.OPENCODE_MEMORY_DIR ?? path.join(os.homedir(), ".local", "share", "opencode", "memory")
export const STORE_FILE = path.join(DATA_DIR, "store.json")
export const STATE_FILE = path.join(DATA_DIR, "state.json")
export const SUMMARY_FILE = path.join(DATA_DIR, "SUMMARY.md")
export const LOCK_FILE = path.join(DATA_DIR, ".lock")

// Tool configuration passed in the promptAsync body of EVERY headless helper
// session (DREAM consolidation, semantic dedup check, semantic rerank).
//
// CONTRACT (verified against OpenCode server source v1.18.0 and v1.18.20):
//   - packages/opencode/src/session/prompt.ts turns each body.tools entry
//     into a session permission rule { permission: key, action:
//     enabled ? "allow" : "deny", pattern: "*" }.
//   - packages/opencode/src/session/llm/request.ts (resolveTools) removes a
//     tool from the model-visible toolset when the LAST matching rule denies
//     it with pattern "*", and Permission glob-matching makes the permission
//     key "*" match every tool id (built-in, plugin-registered, MCP).
// Therefore { "*": false } is a true allow-none configuration. NEVER replace
// this with an enumeration of tool names: any unlisted tool (including tools
// added by future OpenCode versions or other plugins) would stay enabled in
// the untrusted-child session. See tests/containment.test.ts.
export const SESSION_TOOLS_DENY_ALL: Record<string, boolean> = { "*": false }
