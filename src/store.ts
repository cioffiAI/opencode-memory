// Store I/O: atomic writes, cross-instance lockfile, always-fresh reads.
// Split out of index.ts so persistence concerns have a single boundary; the
// consolidation and tool paths all go through these helpers.

import { mkdir, open, readFile, rename, unlink, writeFile } from "fs/promises"
import path from "path"
import { CONFIG, DATA_DIR, LOCK_FILE, STATE_FILE, STORE_FILE, SUMMARY_FILE } from "./config.ts"
import { emptyStore, normalizeStore, type Store } from "./core.ts"

function now() {
  return Date.now()
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(DATA_DIR, { recursive: true }).catch(() => {})
  let fd: Awaited<ReturnType<typeof open>> | undefined
  for (let i = 0; i < 40; i++) {
    try {
      fd = await open(LOCK_FILE, "wx")
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
    await unlink(LOCK_FILE).catch(() => {})
  }
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
// the critical sections that call readStore() themselves.
async function readStore(): Promise<Store> {
  return normalizeStore(await readJson<Store>(STORE_FILE, emptyStore()))
}

export async function getStore(): Promise<Store> {
  return readStore()
}

export async function writeStore(store: Store) {
  await writeJson(STORE_FILE, store)
  await writeFile(
    SUMMARY_FILE,
    `# opencode memory summary\n\nUpdated: ${new Date(store.updatedAt).toISOString()}\n\n${store.summary || "_No summary yet — it is generated after the first consolidation._"}\n`,
    "utf8",
  )
}

export type InProgress = {
  targetTs: number
  startedAt: number
  childID?: string
}

export type State = {
  sessions: Record<string, number>
  inProgress?: Record<string, InProgress>
}

export async function getState(): Promise<State> {
  const state = await withLock(() => readJson<State>(STATE_FILE, { sessions: {}, inProgress: {} }))
  state.sessions = state.sessions ?? {}
  state.inProgress = state.inProgress ?? {}
  return state
}

export async function saveState(state: State) {
  await withLock(() => writeJson(STATE_FILE, state))
}
