// @ts-nocheck — focused fake contexts for both OpenCode adapter shapes.
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index.ts"

function entries(dir: string) {
  return JSON.parse(readFileSync(join(dir, "store.json"), "utf8")).entries
}

test("V1 keeps opencode.jsonc options and store paths separate per instance", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v1-options-"))
  const a = join(root, "a")
  const b = join(root, "b")
  const client = {
    session: {
      get: async () => ({ data: { directory: "/project-b" } }),
      messages: async () => ({ data: [] }),
    },
  }
  try {
    const first = await plugin.server({ client }, { dir: a, dream: false, surface: false })
    const second = await plugin.server({ client }, { dir: b, dream: false, surface: true })
    await first.tool.memory_write.execute({ fact: "Project A prefers tea.", category: "preferences" }, { directory: "/project-a" })
    await second.tool.memory_write.execute({ fact: "Project B prefers coffee.", category: "preferences" }, { directory: "/project-b" })
    expect(entries(a).map((entry) => entry.text)).toEqual(["Project A prefers tea."])
    expect(entries(b).map((entry) => entry.text)).toEqual(["Project B prefers coffee."])
    const blocked = { system: [] }
    const enabled = { system: [] }
    await first["experimental.chat.system.transform"]({ sessionID: "a" }, blocked)
    await second["experimental.chat.system.transform"]({ sessionID: "b" }, enabled)
    expect(blocked.system).toEqual([])
    expect(enabled.system.join("\n")).toContain("Project B prefers coffee.")
    expect(enabled.system.join("\n")).not.toContain("Project A prefers tea.")
    await first.dispose()
    await second.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V2 keeps opencode.jsonc options and store paths separate per instance", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-v2-options-"))
  function context(dir: string, directory: string, surface: boolean) {
    const tools = []
    const hooks = {}
    const ctx = {
      options: { dir, dream: false, surface },
      location: { directory },
      tool: {
        transform: async (callback) => {
          callback({ add: (tool) => tools.push(tool) })
          return { dispose: async () => {} }
        },
        list: async () => tools.map((tool) => ({ id: tool.name })),
      },
      session: {
        hook: async (name, callback) => {
          hooks[name] = callback
          return { dispose: async () => {} }
        },
        get: async () => ({ location: { directory } }),
        context: async () => [],
      },
    }
    return { ctx, tools, hooks }
  }
  try {
    const a = context(join(root, "a"), "/project-a", false)
    const b = context(join(root, "b"), "/project-b", true)
    const cleanupA = await plugin.setup(a.ctx)
    const cleanupB = await plugin.setup(b.ctx)
    const toolContext = { sessionID: "session", signal: new AbortController().signal, progress: async () => {} }
    await a.tools.find((tool) => tool.name === "memory_write").execute({ fact: "Project A prefers tea.", category: "preferences" }, toolContext)
    await b.tools.find((tool) => tool.name === "memory_write").execute({ fact: "Project B prefers coffee.", category: "preferences" }, toolContext)
    expect(entries(join(root, "a")).map((entry) => entry.text)).toEqual(["Project A prefers tea."])
    expect(entries(join(root, "b")).map((entry) => entry.text)).toEqual(["Project B prefers coffee."])
    expect(a.hooks.context).toBeUndefined()
    const event = { sessionID: "session", system: [] }
    await b.hooks.context(event)
    expect(event.system.map((part) => part.text).join("\n")).toContain("Project B prefers coffee.")
    expect(event.system.map((part) => part.text).join("\n")).not.toContain("Project A prefers tea.")
    await cleanupA()
    await cleanupB()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
