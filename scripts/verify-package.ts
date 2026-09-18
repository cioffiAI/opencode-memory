// Isolated installation check for the artifact that will be published
// (issues #2/#3).
//
// A package that builds is not necessarily a package that runs: the plugin
// imports `@opencode-ai/plugin` at load time, so the tarball a user installs
// must resolve that module from ITS OWN declared runtime dependencies, never
// from this checkout's devDependencies (or its node_modules). This script
// verifies exactly that, on the real artifact:
//
//   1. build                    (bun run build)
//   2. pack                     (bun pm pack: the actual tarball)
//   3. isolated install         (fresh temp dir OUTSIDE the checkout)
//   4. import by package name   (resolution happens against the install dir)
//   5. initialize + dispose     (the nine tools are registered, timers freed)
//
// Run with: bun run verify:package   (also part of prepublishOnly)
//
// NOT covered here (manual release checklist): loading the same tarball in a
// clean OpenCode profile, on every supported platform.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const PKG_NAME = "@cioffi_ai/opencode-memory"
const EXPECTED_TOOLS = [
  "memory_read",
  "memory_write",
  "memory_update",
  "memory_why",
  "memory_inspect",
  "memory_useful",
  "memory_irrelevant",
  "memory_forget",
  "memory_clear",
]

function run(cmd: string[], cwd: string, env: Record<string, string> = {}): string {
  const res = Bun.spawnSync({ cmd, cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  if (res.exitCode !== 0) {
    process.stderr.write(res.stdout.toString())
    process.stderr.write(res.stderr.toString())
    throw new Error(`command failed (exit ${res.exitCode}): ${cmd.join(" ")}`)
  }
  return res.stdout.toString()
}

function step(message: string) {
  console.log(`verify:package — ${message}`)
}

// Executed by the isolated install: imports the package BY NAME (so Node/Bun
// resolves `@opencode-ai/plugin` inside the install dir), initializes the
// plugin with a minimal client and an isolated memory dir, asserts the tool
// surface, then disposes.
const CHECK_SCRIPT = `
import { readFileSync } from "node:fs"
import plugin from "${PKG_NAME}"

const EXPECTED = ${JSON.stringify(EXPECTED_TOOLS)}
const manifest = JSON.parse(readFileSync("node_modules/${PKG_NAME}/package.json", "utf8"))
if (!manifest.dependencies?.["@opencode-ai/plugin"]) {
  console.error("FAIL: installed package does not declare @opencode-ai/plugin in dependencies")
  process.exit(1)
}

const client = { app: { log: async () => {} } }
const instance = await plugin({ client })

const actual = Object.keys(instance.tool ?? {}).sort()
const expected = [...EXPECTED].sort()
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error("FAIL: registered tools mismatch")
  console.error("  expected:", expected.join(", "))
  console.error("  actual:  ", actual.join(", "))
  process.exit(1)
}
for (const [name, t] of Object.entries(instance.tool)) {
  if (typeof t?.execute !== "function") {
    console.error("FAIL: tool without execute():", name)
    process.exit(1)
  }
}

await instance.dispose()
console.log("OK: " + actual.length + " tools registered, dispose() completed")
`

const artifactsDir = mkdtempSync(join(tmpdir(), "opencode-memory-artifacts-"))
const installDir = mkdtempSync(join(tmpdir(), "opencode-memory-install-"))
let ok = false
try {
  step("build")
  run(["bun", "run", "build"], ROOT)

  step("pack the real tarball")
  const packed = run(
    ["bun", "pm", "pack", "--destination", artifactsDir, "--ignore-scripts", "--quiet"],
    ROOT,
  ).trim()
  const listed = packed.split("\n").map((l) => l.trim()).filter(Boolean)
  let tarball = listed[listed.length - 1] ?? ""
  if (!tarball.endsWith(".tgz")) {
    tarball = readdirSync(artifactsDir).filter((f) => f.endsWith(".tgz")).map((f) => join(artifactsDir, f))[0] ?? ""
  }
  if (!tarball) throw new Error(`could not locate packed tarball (pack output: ${packed || "(empty)"})`)
  step(`tarball: ${tarball}`)

  step("install in a clean directory outside the checkout")
  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify({ name: "opencode-memory-install-check", private: true }, null, 2),
  )
  run(["bun", "add", tarball], installDir)

  step("import, initialize, assert tools, dispose")
  writeFileSync(join(installDir, "check.mjs"), CHECK_SCRIPT)
  const out = run(["bun", "check.mjs"], installDir, { OPENCODE_MEMORY_DIR: join(installDir, "memory") })
  process.stdout.write(out)

  step("OK — the tarball runs standalone")
  ok = true
} finally {
  if (ok) {
    rmSync(artifactsDir, { recursive: true, force: true })
    rmSync(installDir, { recursive: true, force: true })
  } else {
    console.error(`verify:package FAILED — directories kept for inspection:\n  ${artifactsDir}\n  ${installDir}`)
    process.exitCode = 1
  }
}
