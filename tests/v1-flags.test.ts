import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function check(extraEnv: Record<string, string>) {
  const memoryDir = mkdtempSync(join(tmpdir(), "opencode-memory-v1-flags-"))
  try {
    const result = Bun.spawnSync({
      cmd: ["bun", join(import.meta.dir, "fixtures", "v1-flags-check.ts")],
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        OPENCODE_MEMORY_DIR: memoryDir,
        OPENCODE_MEMORY_DREAM: "1",
        OPENCODE_MEMORY_SURFACE: "1",
        OPENCODE_MEMORY_DELAY_MS: "0",
        OPENCODE_MEMORY_SWEEP_START_MS: "600000",
        OPENCODE_MEMORY_SWEEP_MS: "600000",
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode, `${result.stdout.toString()}\n${result.stderr.toString()}`).toBe(0)
    expect(result.stdout.toString()).toContain("V1_FLAGS_OK")
  } finally {
    rmSync(memoryDir, { recursive: true, force: true })
  }
}

test("V1 can disable DREAM while keeping tools and SURFACE", () => {
  check({ OPENCODE_MEMORY_DREAM: "0", V1_CHECK_DREAM_DISABLED: "1" })
})

test("V1 can disable SURFACE while keeping explicit tools", () => {
  check({ OPENCODE_MEMORY_SURFACE: "0", V1_CHECK_SURFACE_DISABLED: "1" })
})

test("V1 can disable both automatic processes", () => {
  check({
    OPENCODE_MEMORY_DREAM: "0", OPENCODE_MEMORY_SURFACE: "0",
    V1_CHECK_DREAM_DISABLED: "1", V1_CHECK_SURFACE_DISABLED: "1",
  })
})
