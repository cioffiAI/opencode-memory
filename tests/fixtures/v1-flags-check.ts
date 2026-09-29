// @ts-nocheck
import { mkdir, readFile } from "node:fs/promises"
import plugin from "../../src/index.ts"

const dreamDisabled = process.env.V1_CHECK_DREAM_DISABLED === "1"
const surfaceDisabled = process.env.V1_CHECK_SURFACE_DISABLED === "1"
const directory = process.cwd()
const memoryDir = process.env.OPENCODE_MEMORY_DIR
let sessionReads = 0
const client = {
  session: {
    get: async () => {
      sessionReads++
      return { data: { id: "v1-session", directory } }
    },
    messages: async () => {
      sessionReads++
      return { data: [{ info: { role: "user" }, parts: [{ type: "text", text: "coffee" }] }] }
    },
  },
}

await mkdir(memoryDir, { recursive: true })
const hooks = await plugin.server({ client })
if (!hooks.tool?.memory_write) throw new Error("explicit memory tool is unavailable")
await hooks.tool.memory_write.execute({ fact: "The user drinks coffee." }, { directory })

if (dreamDisabled) {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "v1-session" } } })
  await Bun.sleep(30)
  if (sessionReads !== 0) throw new Error("V1 DREAM read a session while disabled")
}

const output = { system: [] }
await hooks["experimental.chat.system.transform"]({ sessionID: "v1-session" }, output)
if (surfaceDisabled) {
  if (output.system.length !== 0 || sessionReads !== 0) throw new Error("V1 SURFACE ran while disabled")
} else if (!output.system.join("\n").includes("The user drinks coffee.")) {
  throw new Error("V1 SURFACE did not inject the explicit memory")
}

const store = JSON.parse(await readFile(`${memoryDir}/store.json`, "utf8"))
if (store.entries.length !== 1 || store.entries[0].source !== "explicit") throw new Error("explicit write was lost")
await hooks.dispose()
console.log("V1_FLAGS_OK")
