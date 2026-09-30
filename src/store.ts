// Store I/O: atomic writes, cross-instance lockfile, always-fresh reads.
// Split out of index.ts so persistence concerns have a single boundary; the
// consolidation and tool paths all go through these helpers.

import { mkdir, open, readFile, rename, unlink, writeFile } from "fs/promises"
import path from "path"
import { resolveConfig } from "./config.ts"
import { emptyStore, normalizeStore, type Store } from "./core.ts"

function now() {
  return Date.now()
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true }).catch(() => {})
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8")
  await rename(tmp, file)
}

// Always read the store fresh from disk: the consolidation writes it inside
// its own lock, and a stale in-memory copy would make the consolidation
// prompt and the dedup guard see outdated entries (or none at all).
// No lock needed on read: writeJson uses an atomic rename, so we always see
// a complete file (old or new version). This also avoids nested locks inside
// the critical sections that call getStore() themselves.
export type InProgress = {
  targetTs: number
  startedAt: number
  childID?: string
}

export type State = {
  sessions: Record<string, number>
  inProgress?: Record<string, InProgress>
}

// Share a queue across instances using the same directory. The filesystem
// lock still protects against other processes; local callers wait their turn
// without consuming the cross-process lock timeout.
const lockQueues = new Map<string, Promise<void>>()

export function createStore(dataDir: string) {
  dataDir = path.resolve(dataDir)
  const lockFile = path.join(dataDir, ".lock")
  const storeFile = path.join(dataDir, "store.json")
  const stateFile = path.join(dataDir, "state.json")
  const summaryFile = path.join(dataDir, "SUMMARY.md")

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = lockQueues.get(lockFile) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>((resolve) => { release = resolve })
    lockQueues.set(lockFile, turn)
    await previous
    try {
      await mkdir(dataDir, { recursive: true }).catch(() => {})
      let fd: Awaited<ReturnType<typeof open>> | undefined
      for (let i = 0; i < 40; i++) {
        try {
          fd = await open(lockFile, "wx")
          break
        } catch {
          await sleep(50)
        }
      }
      if (!fd) throw new Error("memory store lock timeout")
      try {
        return await fn()
      } finally {
        await fd.close().catch(() => {})
        await unlink(lockFile).catch(() => {})
      }
    } finally {
      release()
      if (lockQueues.get(lockFile) === turn) lockQueues.delete(lockFile)
    }
  }

  async function getStore(): Promise<Store> {
    return normalizeStore(await readJson<Store>(storeFile, emptyStore()))
  }

  async function writeStore(store: Store) {
    await writeJson(storeFile, store)
    await writeFile(
      summaryFile,
      `# opencode memory summary\n\nUpdated: ${new Date(store.updatedAt).toISOString()}\n\n${store.summary || "_No summary yet — it is generated after the first consolidation._"}\n`,
      "utf8",
    )
  }

  async function getState(): Promise<State> {
    const state = await withLock(() => readJson<State>(stateFile, { sessions: {}, inProgress: {} }))
    state.sessions = state.sessions ?? {}
    state.inProgress = state.inProgress ?? {}
    return state
  }

  async function saveState(state: State) {
    await withLock(() => writeJson(stateFile, state))
  }

  return { withLock, getStore, writeStore, getState, saveState }
}

export type StoreIO = ReturnType<typeof createStore>
// Direct callers retain the default helpers. Resolve their environment only
// when first used, so plugin options can override it during adapter setup.
let defaultStore: StoreIO | undefined
function defaultIO(): StoreIO {
  return defaultStore ??= createStore(resolveConfig().dir)
}

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  return defaultIO().withLock(fn)
}

export function getStore(): Promise<Store> {
  return defaultIO().getStore()
}

export function writeStore(store: Store): Promise<void> {
  return defaultIO().writeStore(store)
}

export function getState(): Promise<State> {
  return defaultIO().getState()
}

export function saveState(state: State): Promise<void> {
  return defaultIO().saveState(state)
}
