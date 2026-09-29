// Plugin configuration and well-known paths, split out of index.ts so tests
// can import constants (e.g. the child-session tool containment contract)
// without loading the OpenCode plugin runtime.

export const CONSOLIDATION_TITLE = "memory-consolidation"
export const RERANK_TITLE = "memory-surfacing"

import path from "path"
import os from "os"

const DEFAULT_DIR = path.join(os.homedir(), ".local", "share", "opencode", "memory")

const OPTION_ENV = {
  off: "OPENCODE_MEMORY_OFF",
  dream: "OPENCODE_MEMORY_DREAM",
  surface: "OPENCODE_MEMORY_SURFACE",
  dir: "OPENCODE_MEMORY_DIR",
  debug: "OPENCODE_MEMORY_DEBUG",
  delayMs: "OPENCODE_MEMORY_DELAY_MS",
  maxEntries: "OPENCODE_MEMORY_MAX_ENTRIES",
  maxFacts: "OPENCODE_MEMORY_MAX_FACTS",
  maxChars: "OPENCODE_MEMORY_MAX_CHARS",
  transcriptChars: "OPENCODE_MEMORY_TRANSCRIPT_CHARS",
  sweepIntervalMs: "OPENCODE_MEMORY_SWEEP_MS",
  sweepStartMs: "OPENCODE_MEMORY_SWEEP_START_MS",
  sweepBatch: "OPENCODE_MEMORY_SWEEP_BATCH",
  gcChildAgeMs: "OPENCODE_MEMORY_GC_CHILD_AGE_MS",
  inProgressTimeoutMs: "OPENCODE_MEMORY_INPROGRESS_TIMEOUT_MS",
  rerank: "OPENCODE_MEMORY_RERANK",
  rerankCandidates: "OPENCODE_MEMORY_RERANK_CANDIDATES",
  rerankTimeoutMs: "OPENCODE_MEMORY_RERANK_TIMEOUT_MS",
  rerankCacheMs: "OPENCODE_MEMORY_RERANK_CACHE_MS",
  coreSlot: "OPENCODE_MEMORY_CORE_SLOT",
  surfaceRefreshMs: "OPENCODE_MEMORY_SURFACE_REFRESH_MS",
} as const

export type MemoryConfig = {
  off: boolean
  dream: boolean
  surface: boolean
  dir: string
  debug: boolean
  delayMs: number
  maxEntries: number
  maxFacts: number
  maxChars: number
  transcriptChars: number
  sweepIntervalMs: number
  sweepStartMs: number
  sweepBatch: number
  gcChildAgeMs: number
  inProgressTimeoutMs: number
  rerank: boolean
  rerankCandidates: number
  rerankTimeoutMs: number
  rerankCacheMs: number
  coreSlot: number
  surfaceRefreshMs: number
}

export function resolveConfig(options: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("opencode-memory options must be an object")
  }
  for (const key of Object.keys(options)) {
    if (!(key in OPTION_ENV)) throw new Error(`unknown opencode-memory option: ${key}`)
  }

  function raw(key: keyof typeof OPTION_ENV): unknown {
    return Object.hasOwn(options, key) ? options[key] : env[OPTION_ENV[key]]
  }

  function boolean(key: keyof typeof OPTION_ENV, fallback: boolean): boolean {
    const value = raw(key)
    if (value === undefined) return fallback
    if (typeof value === "boolean") return value
    if (typeof value === "string" && !Object.hasOwn(options, key)) {
      // Existing environment switches treated every value except "1" as off.
      // Keep that behavior for installations upgrading from 1.7.0.
      if (key === "off" || key === "debug" || key === "rerank") return value === "1"
      if (value === "1") return true
      if (value === "0") return false
    }
    throw new Error(`opencode-memory ${key} must be a boolean (environment: 1 or 0)`)
  }

  function integer(key: keyof typeof OPTION_ENV, fallback: number, min: number): number {
    const value = raw(key)
    if (value === undefined) return fallback
    const number = typeof value === "string" && !Object.hasOwn(options, key) && value.trim() !== ""
      ? Number(value) : value
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min) {
      throw new Error(`opencode-memory ${key} must be an integer >= ${min}`)
    }
    return number
  }

  const dir = raw("dir") ?? DEFAULT_DIR
  if (typeof dir !== "string" || dir.trim() === "") throw new Error("opencode-memory dir must be a nonempty path")
  const expandedDir = dir === "~" ? os.homedir() : dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir
  if (Object.hasOwn(options, "dir") && !path.isAbsolute(expandedDir)) {
    throw new Error("opencode-memory dir option must be an absolute path")
  }

  return {
    off: boolean("off", false),
    dream: boolean("dream", true),
    surface: boolean("surface", true),
    dir: path.resolve(expandedDir),
    debug: boolean("debug", false),
    delayMs: integer("delayMs", 90000, 0),
    maxEntries: integer("maxEntries", 400, 1),
    maxFacts: integer("maxFacts", 18, 0),
    maxChars: integer("maxChars", 2400, 1),
    transcriptChars: integer("transcriptChars", 12000, 1),
    sweepIntervalMs: integer("sweepIntervalMs", 10 * 60 * 1000, 1),
    sweepStartMs: integer("sweepStartMs", 20000, 0),
    sweepBatch: integer("sweepBatch", 8, 1),
    gcChildAgeMs: integer("gcChildAgeMs", 10 * 60 * 1000, 0),
    inProgressTimeoutMs: integer("inProgressTimeoutMs", 10 * 60 * 1000, 1),
    rerank: boolean("rerank", false),
    rerankCandidates: integer("rerankCandidates", 30, 1),
    rerankTimeoutMs: integer("rerankTimeoutMs", 4000, 1),
    rerankCacheMs: integer("rerankCacheMs", 60 * 1000, 0),
    coreSlot: integer("coreSlot", 3, 0),
    surfaceRefreshMs: integer("surfaceRefreshMs", 15 * 60 * 1000, 0),
  }
}

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
