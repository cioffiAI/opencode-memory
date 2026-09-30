import { expect, test } from "bun:test"
import { join } from "node:path"
import { resolveConfig } from "../src/config.ts"

test("plugin options override environment values and preserve defaults", () => {
  const config = resolveConfig({
    dream: false,
    surface: false,
    summary: false,
    dir: "/tmp/memory-from-config",
    delayMs: 25,
    rerank: true,
    coreSlot: 0,
  }, {
    OPENCODE_MEMORY_DREAM: "1",
    OPENCODE_MEMORY_SURFACE: "1",
    OPENCODE_MEMORY_SUMMARY: "1",
    OPENCODE_MEMORY_DIR: "/tmp/memory-from-env",
    OPENCODE_MEMORY_DELAY_MS: "90",
    OPENCODE_MEMORY_MAX_FACTS: "7",
  })
  expect(config.dream).toBe(false)
  expect(config.surface).toBe(false)
  expect(config.summary).toBe(false)
  expect(config.dir).toBe("/tmp/memory-from-config")
  expect(config.delayMs).toBe(25)
  expect(config.maxFacts).toBe(7)
  expect(config.rerank).toBe(true)
  expect(config.coreSlot).toBe(0)
  expect(config.maxEntries).toBe(400)
})

test("every environment setting can be supplied through plugin options", () => {
  const options = {
    off: true, dream: false, surface: false, summary: false, dir: "/tmp/memory-all-options",
    debug: true, delayMs: 0, maxEntries: 1, maxFacts: 0, maxChars: 1,
    transcriptChars: 1, sweepIntervalMs: 1, sweepStartMs: 0, sweepBatch: 1,
    gcChildAgeMs: 0, inProgressTimeoutMs: 1, rerank: true,
    rerankCandidates: 1, rerankTimeoutMs: 1, rerankCacheMs: 0,
    coreSlot: 0, surfaceRefreshMs: 0,
  }
  expect(resolveConfig(options, {})).toEqual(options)
})

test("invalid options fail at setup with the offending name", () => {
  expect(() => resolveConfig({ dreem: false }, {})).toThrow("dreem")
  expect(() => resolveConfig({ dream: "false" }, {})).toThrow("dream")
  expect(() => resolveConfig({ summary: "false" }, {})).toThrow("summary")
  expect(() => resolveConfig({ delayMs: -1 }, {})).toThrow("delayMs")
  expect(() => resolveConfig({ rerankTimeoutMs: Infinity }, {})).toThrow("rerankTimeoutMs")
  expect(() => resolveConfig({ dir: "" }, {})).toThrow("dir")
  expect(() => resolveConfig({ dir: "relative/path" }, {})).toThrow("absolute")
})

test("summary is enabled by default and accepts a strict environment switch", () => {
  expect(resolveConfig({}, {}).summary).toBe(true)
  expect(resolveConfig({}, { OPENCODE_MEMORY_SUMMARY: "0" }).summary).toBe(false)
  expect(() => resolveConfig({}, { OPENCODE_MEMORY_SUMMARY: "false" })).toThrow("summary")
  expect(resolveConfig({ summary: false }, { OPENCODE_MEMORY_SUMMARY: "invalid" }).summary).toBe(false)
})

test("an invalid environment value cannot prevent a plugin option from taking precedence", () => {
  const result = Bun.spawnSync({
    cmd: ["bun", "-e", `await import(${JSON.stringify(join(import.meta.dir, "..", "src", "index.ts"))})`],
    env: { ...process.env, OPENCODE_MEMORY_DELAY_MS: "invalid" },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(resolveConfig({ delayMs: 25 }, { OPENCODE_MEMORY_DELAY_MS: "invalid" }).delayMs).toBe(25)
})

test("existing environment booleans keep their 1.7.0 behavior", () => {
  const config = resolveConfig({}, { OPENCODE_MEMORY_OFF: "false", OPENCODE_MEMORY_DEBUG: "no", OPENCODE_MEMORY_RERANK: "false" })
  expect(config.off).toBe(false)
  expect(config.debug).toBe(false)
  expect(config.rerank).toBe(false)
})
