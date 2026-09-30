import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index.ts"
import { createStore } from "../src/store.ts"

const facts = [
  "The user prefers that repositories be useful and non-wordy.",
  "The user prefers concise responses.",
]
const staleSummary = "STALE_SUMMARY_SHOULD_NOT_REACH_MODEL"
const directory = "/project"

async function harness(major: 1 | 2, dir: string, options: Record<string, unknown> = {}) {
  const config = { dir, dream: false, surface: true, ...options }
  if (major === 1) {
    const instance = await plugin.server({ client: {
      session: {
        get: async () => ({ data: { directory } }),
        messages: async () => ({ data: [] }),
      },
    } }, config) as any
    return {
      call: (name: string, args: Record<string, unknown> = {}) => instance.tool[name].execute(args, { directory, sessionID: "session" }) as Promise<string>,
      surface: async () => {
        const output = { system: [] as string[] }
        await instance["experimental.chat.system.transform"]({ sessionID: "session" }, output)
        return output.system.join("\n")
      },
      dispose: () => instance.dispose(),
    }
  }
  const tools = new Map<string, any>()
  let hook: ((event: any) => Promise<void>) | undefined
  const dispose = await plugin.setup({
    options: config,
    location: { directory },
    tool: {
      transform: async (callback: any) => {
        callback({ add: (tool: any) => tools.set(tool.name, tool) })
        return { dispose: async () => {} }
      },
      list: async () => [...tools.keys()].map((id) => ({ id })),
    },
    session: {
      get: async () => ({ location: { directory } }),
      context: async () => [],
      hook: async (_name: string, callback: any) => {
        hook = callback
        return { dispose: async () => {} }
      },
    },
  } as any)
  return {
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await tools.get(name).execute(args, { sessionID: "session" })).content as string,
    surface: async () => {
      const event = { sessionID: "session", system: [] as { text: string }[] }
      await hook?.(event)
      return event.system.map((part) => part.text).join("\n")
    },
    dispose: async () => { await dispose?.() },
  }
}

for (const major of [1, 2] as const) {
  for (const parallel of [false, true]) {
    test(`V${major} retains both facts from #11 when written ${parallel ? "in parallel" : "in sequence"}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "memory-distinct-writes-"))
      const instance = await harness(major, dir)
      try {
        const write = (fact: string) => instance.call("memory_write", { fact, category: "preferences" })
        if (parallel) await Promise.all(facts.map(write))
        else for (const fact of facts) await write(fact)
        expect((await createStore(dir).getStore()).entries.map((entry) => entry.text).sort()).toEqual([...facts].sort())
        await Promise.all(facts.map(write))
        expect((await createStore(dir).getStore()).entries).toHaveLength(2)
      } finally {
        await instance.dispose()
        await rm(dir, { recursive: true, force: true })
      }
    })
  }

  test(`V${major} serializes concurrent mutations across instances sharing a store`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-mixed-tools-"))
    const first = await harness(major, dir, { surface: false })
    const second = await harness(major, dir, { surface: false })
    const io = createStore(dir)
    try {
      await first.call("memory_write", { fact: "Alpha original fact." })
      await first.call("memory_write", { fact: "Beta removable fact." })
      await first.call("memory_write", { fact: "Gamma retained fact." })
      const before = await io.getStore()
      const id = (prefix: string) => before.entries.find((entry) => entry.text.startsWith(prefix))!.id
      await Promise.all([
        first.call("memory_update", { id: id("Alpha"), fact: "Alpha corrected fact." }),
        second.call("memory_forget", { id: id("Beta") }),
        first.call("memory_useful", { id: id("Gamma") }),
        second.call("memory_write", { fact: "Delta additional fact." }),
      ])
      const after = await io.getStore()
      expect(after.entries.map((entry) => entry.text).sort()).toEqual([
        "Alpha corrected fact.", "Delta additional fact.", "Gamma retained fact.",
      ])
      expect(after.entries.find((entry) => entry.id === id("Gamma"))?.helpfulCount).toBe(1)
    } finally {
      await first.dispose()
      await second.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test(`V${major} hides a disabled summary in tools and context and clears only the summary`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-summary-control-"))
    const instance = await harness(major, dir, { summary: false })
    const io = createStore(dir)
    try {
      await instance.call("memory_write", { fact: "The user drinks coffee.", category: "preferences" })
      const seeded = await io.getStore()
      seeded.summary = staleSummary
      await io.withLock(() => io.writeStore(seeded))
      expect(await instance.call("memory_read")).not.toContain(staleSummary)
      expect(await instance.call("memory_inspect")).toContain("Summary: disabled")
      const surfaced = await instance.surface()
      expect(surfaced).not.toContain(staleSummary)
      expect(surfaced).toContain("The user drinks coffee.")
      expect((await io.getStore()).summary).toBe(staleSummary)
      expect(await instance.call("memory_clear", { summaryOnly: true })).toContain("summary")
      const cleared = await io.getStore()
      expect(cleared.summary).toBe("")
      expect(cleared.entries).toHaveLength(1)
      expect(await readFile(join(dir, "SUMMARY.md"), "utf8")).not.toContain(staleSummary)
    } finally {
      await instance.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test(`V${major} can clear an enabled summary without deleting facts`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-summary-clear-"))
    const instance = await harness(major, dir)
    const io = createStore(dir)
    try {
      await instance.call("memory_write", { fact: "Coffee is preferred.", category: "preferences" })
      const store = await io.getStore()
      store.summary = staleSummary
      await io.withLock(() => io.writeStore(store))
      expect(await instance.call("memory_read")).toContain(staleSummary)
      expect(await instance.call("memory_clear", { summaryOnly: true, scope: "project" })).toContain("omit scope")
      expect((await io.getStore()).summary).toBe(staleSummary)
      await instance.call("memory_clear", { summaryOnly: true })
      expect((await io.getStore()).entries).toHaveLength(1)
      expect(await instance.call("memory_read")).not.toContain(staleSummary)
    } finally {
      await instance.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
}

for (const summary of [true, false]) {
  test(`V1 DREAM ${summary ? "generates an enabled" : "preserves but never requests or updates a disabled"} summary`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-v1-dream-summary-"))
    const io = createStore(dir)
    await io.withLock(async () => {
      const store = await io.getStore()
      store.summary = staleSummary
      await io.writeStore(store)
    })
    let prompt = ""
    let complete!: () => void
    const completed = new Promise<void>((resolve) => { complete = resolve })
    const instance = await plugin.server({ client: { session: {
      get: async () => ({ data: { id: "parent", directory, title: "Summary test" } }),
      messages: async ({ path }: any) => ({ data: path.id === "child" ? [{
        info: { role: "assistant", time: { completed: Date.now() + 1000 } },
        parts: [{ type: "text", text: JSON.stringify({ new: [], update: [], delete: [], conflicts: [], summary: "NEW_MODEL_SUMMARY" }) }],
      }] : [{ info: { role: "user", time: { created: 100 } }, parts: [{ type: "text", text: "I use teal terminal themes." }] }] }),
      create: async () => ({ data: { id: "child" } }),
      promptAsync: async ({ body }: any) => { prompt = body.parts[0].text },
      delete: async () => { complete() },
    } } }, { dir, dream: true, surface: false, summary, delayMs: 0, sweepStartMs: 600000 }) as any
    try {
      await instance.event({ event: { type: "session.idle", properties: { sessionID: "parent" } } })
      await completed
      expect(prompt).not.toContain(staleSummary)
      if (summary) expect(prompt).toContain('"summary"')
      else expect(prompt).not.toContain("summary")
      expect((await io.getStore()).summary).toBe(summary ? "NEW_MODEL_SUMMARY" : staleSummary)
      expect((await io.getState()).sessions.parent).toBe(100)
    } finally {
      await instance.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test("store locks queue many concurrent calls across instances without losing mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-store-contention-"))
  const stores = [createStore(dir), createStore(dir)]
  try {
    const results = await Promise.allSettled(Array.from({ length: 48 }, (_, index) => {
      const io = stores[index % stores.length]!
      return io.withLock(async () => {
        const store = await io.getStore()
        store.summary += `${index},`
        await Bun.sleep(2)
        await io.writeStore(store)
      })
    }))
    expect(results.filter((result) => result.status === "rejected")).toEqual([])
    expect((await stores[0]!.getStore()).summary.split(",").filter(Boolean).map(Number).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 48 }, (_, index) => index))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a rejected mutation releases the shared store queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-store-rejected-"))
  const first = createStore(dir)
  const second = createStore(dir)
  try {
    const results = await Promise.allSettled([
      first.withLock(async () => { throw new Error("expected failure") }),
      second.withLock(async () => {
        const store = await second.getStore()
        store.summary = "next mutation completed"
        await second.writeStore(store)
      }),
    ])
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"])
    expect((await first.getStore()).summary).toBe("next mutation completed")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("filesystem locking preserves queued mutations from separate processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-store-processes-"))
  const script = `
    import { createStore } from ${JSON.stringify(join(import.meta.dir, "..", "src", "store.ts"))};
    const io = createStore(process.argv[1]);
    await Promise.all(Array.from({length: 24}, (_, index) => io.withLock(async () => {
      const store = await io.getStore();
      store.summary += process.argv[2] + index + ",";
      await Bun.sleep(2);
      await io.writeStore(store);
    })));
  `
  try {
    const children = ["a", "b"].map((prefix) => Bun.spawn(["bun", "-e", script, dir, prefix], { stdout: "pipe", stderr: "pipe" }))
    const results = await Promise.all(children.map(async (child) => ({
      error: await new Response(child.stderr).text(), exit: await child.exited,
    })))
    for (const result of results) expect(result.exit, result.error).toBe(0)
    const written = (await createStore(dir).getStore()).summary.split(",").filter(Boolean).sort()
    expect(written).toEqual(["a", "b"].flatMap((prefix) => Array.from({ length: 24 }, (_, index) => `${prefix}${index}`)).sort())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
