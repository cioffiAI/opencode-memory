// @ts-nocheck
import { mkdir, readFile, writeFile } from "node:fs/promises"
import plugin from "../../src/index.ts"

const directory = process.cwd()
const sessionID = "v2-session"
const sweepOnly = process.env.V2_CHECK_SWEEP_ONLY === "1"
const tools = []
const hooks = {}
let generateCalls = 0
let foreignReads = 0
const disposed = []
const failSetup = process.env.V2_CHECK_FAIL_SETUP === "1"
const eventType = process.env.V2_CHECK_EVENT ?? "session.execution.succeeded"

const contextMessages = [
  { id: "user-1", type: "user", text: "I prefer teal terminal themes.", time: { created: 100 } },
  {
    id: "assistant-1",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [{ type: "text", text: "Understood." }],
    time: { created: 101, completed: 102 },
  },
  { id: "idle-1", type: "idle", outcome: "succeeded", time: { created: 103 } },
]

const ctx = {
  app: { name: "opencode", version: "2.0.11", channel: "test" },
  location: { directory, project: { id: "project", directory, canonical: directory } },
  options: {},
  tool: {
    transform: async (callback) => {
      callback({ add: (definition) => tools.push(definition) })
      return { dispose: async () => { disposed.push("tools") } }
    },
    list: async () => tools.map((tool) => ({ ...tool, id: tool.name })),
  },
  session: {
    hook: async (name, callback) => {
      if (failSetup) throw new Error("simulated hook registration failure")
      hooks[name] = callback
      return { dispose: async () => { disposed.push("context") } }
    },
    get: async ({ sessionID: id }) => ({
      id,
      projectID: "project",
      model: { providerID: "test", id: "test" },
      title: "V2 adapter test",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 103, idle: 103 },
      location: { directory: id === "foreign-session" ? `${directory}/other-project` : directory },
    }),
    context: async ({ sessionID: id }) => {
      if (id === "foreign-session") {
        foreignReads++
        throw new Error("foreign project session must never be consolidated")
      }
      return contextMessages
    },
  },
  event: {
    subscribe: async function* ({ signal }) {
      yield { type: "session.execution.succeeded", data: { sessionID: "foreign-session" } }
      if (!sweepOnly) yield {
        type: eventType,
        ...(eventType === "session.idle" ? { location: { directory } } : {}),
        data: { sessionID },
      }
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
    },
  },
  generate: {
    text: async () => {
      generateCalls++
      return {
        text: JSON.stringify({
          new: [{ text: "The user prefers teal terminal themes.", category: "preferences", scope: "global", confidence: 0.95 }],
          update: [],
          delete: [],
          conflicts: [],
          summary: "The user prefers teal terminal themes.",
        }),
      }
    },
  },
}

if (plugin.id !== "cioffi.opencode-memory" || typeof plugin.setup !== "function" || typeof plugin.server !== "function") {
  throw new Error("hybrid V1/V2 export is invalid")
}

if (sweepOnly) {
  await mkdir(process.env.OPENCODE_MEMORY_DIR, { recursive: true })
  await writeFile(`${process.env.OPENCODE_MEMORY_DIR}/state.json`, JSON.stringify({
    sessions: {},
    inProgress: {
      [sessionID]: { targetTs: 103, startedAt: 0 },
    },
  }))
}

if (failSetup) {
  try {
    await plugin.setup(ctx)
    throw new Error("setup should have failed")
  } catch (error) {
    if (error.message !== "simulated hook registration failure") throw error
  }
  if (JSON.stringify(disposed) !== '["tools"]') throw new Error("failed setup leaked tool registration")
  console.log("V2_CHECK_OK")
  process.exit(0)
}

const cleanup = await plugin.setup(ctx)
if (tools.length !== 9) throw new Error(`expected 9 V2 tools, got ${tools.length}`)

const storePath = `${process.env.OPENCODE_MEMORY_DIR}/store.json`
let store
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    store = JSON.parse(await readFile(storePath, "utf8"))
    if (store.entries.some((entry) => entry.source === "dreamed")) break
  } catch {}
  await Bun.sleep(10)
}
if (!store?.entries.some((entry) => entry.source === "dreamed" && entry.sourceSessionID === sessionID)) {
  throw new Error(`${sweepOnly ? "recovery sweep" : "session.idle"} did not run V2 DREAM consolidation`)
}
if (generateCalls !== 1) throw new Error(`expected one tool-free generate call, got ${generateCalls}`)

const toolContext = {
  sessionID,
  agent: "build",
  messageID: "tool-message",
  id: "tool-call",
  signal: new AbortController().signal,
  progress: async () => {},
}
const write = tools.find((tool) => tool.name === "memory_write")
const read = tools.find((tool) => tool.name === "memory_read")
await write.execute({ fact: "The user drinks coffee in the morning.", category: "preferences" }, toolContext)
await write.execute({ fact: "SECRET_LOCAL_ONLY_VALUE", sensitivity: "local-only" }, toolContext)

const secretRead = await read.execute({ query: "SECRET_LOCAL_ONLY_VALUE" }, toolContext)
if (String(secretRead.content) !== "No memory entries found.") throw new Error("local-only entry leaked through memory_read")

const event = {
  sessionID,
  system: [],
  messages: [],
  tools: {},
  options: {},
  agent: "build",
  model: { providerID: "test", id: "test" },
}
await hooks.context(event)
const block = event.system.map((part) => part.text).join("\n")
if (!block.includes("<memory>")) throw new Error("V2 context hook did not inject memory")
if (block.includes("SECRET_LOCAL_ONLY_VALUE")) throw new Error("local-only entry leaked through context hook")

await cleanup?.()
await cleanup?.()
if (JSON.stringify(disposed) !== '["context","tools"]') throw new Error("cleanup must dispose registrations exactly once in reverse order")
if (foreignReads !== 0) throw new Error("a completion event from another project reached consolidation")
console.log("V2_CHECK_OK")
