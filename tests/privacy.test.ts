import { describe, expect, test } from "bun:test"
import { emptyStore, readQuery, retrieve, type Entry, type Store } from "../src/core.ts"

const PROJ_A = "/workspace/project-a"
const PROJ_B = "/workspace/project-b"

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "e1",
    text: "The user likes coffee.",
    category: "preferences",
    scope: "global",
    weight: 3,
    created: Date.now(),
    lastSeen: Date.now(),
    source: "explicit",
    tier: "archival",
    status: "ACTIVE",
    sensitivity: "normal",
    ...overrides,
  }
}

function storeWith(entries: Entry[]): Store {
  const s = emptyStore()
  s.entries = entries
  return s
}

// memory_read semantics: the model in a session rooted at `directory` may see
// global facts plus the CURRENT project's facts. Local-only facts are never
// returned through any model-visible path (tool responses reach the provider).
describe("readQuery (memory_read policy)", () => {
  const store = storeWith([
    entry({ id: "g-coffee", text: "The user likes coffee." }),
    entry({ id: "a-stack", text: "Project A uses Bun.", category: "project", scope: "project", projectID: PROJ_A }),
    entry({ id: "b-stack", text: "Project B uses Flask.", category: "project", scope: "project", projectID: PROJ_B }),
    entry({ id: "lo", text: "The user's API token is abc123.", sensitivity: "local-only" }),
  ])

  test("returns global + current-project entries, never other projects'", () => {
    const inA = readQuery(store, PROJ_A, {}).map((e) => e.id)
    expect(inA.sort()).toEqual(["a-stack", "g-coffee"])
    const inB = readQuery(store, PROJ_B, {}).map((e) => e.id)
    expect(inB.sort()).toEqual(["b-stack", "g-coffee"])
  })

  test("scope=project shows ONLY the current project's entries", () => {
    expect(readQuery(store, PROJ_A, { scope: "project" }).map((e) => e.id)).toEqual(["a-stack"])
    expect(readQuery(store, PROJ_B, { scope: "project" }).map((e) => e.id)).toEqual(["b-stack"])
  })

  test("scope=global hides project entries entirely", () => {
    expect(readQuery(store, PROJ_A, { scope: "global" }).map((e) => e.id)).toEqual(["g-coffee"])
  })

  test("never returns local-only entries regardless of filters", () => {
    const res = readQuery(store, PROJ_A, { query: "api token" })
    expect(res).toHaveLength(0)
    expect(readQuery(store, undefined, {}).some((e) => e.sensitivity === "local-only")).toBe(false)
  })

  test("text and category filters apply within the visible set", () => {
    expect(readQuery(store, PROJ_A, { query: "bun" }).map((e) => e.id)).toEqual(["a-stack"])
    expect(readQuery(store, PROJ_A, { category: "preferences" }).map((e) => e.id)).toEqual(["g-coffee"])
    // A query about project B's stack must not leak B's entry when run in A.
    expect(readQuery(store, PROJ_A, { query: "flask" })).toHaveLength(0)
  })
})

// Defined collision semantics: a global fact and an equivalent project-scoped
// fact MAY coexist. Neither suppresses the other at write time; in the
// project's context both are retrievable (the project one is not shadowed),
// while outside it only the global one is visible.
describe("global vs equivalent project fact collision", () => {
  test("both entries survive a same-text write targeting different scopes and both surface in-project", () => {
    const store = storeWith([
      entry({ id: "g", text: "The user prefers Bun over npm." }),
      entry({ id: "p", text: "The user prefers Bun over npm.", scope: "project", projectID: PROJ_A }),
    ])
    const inA = retrieve(store, PROJ_A, "which package manager?", Date.now()).map((r) => r.entry.id)
    expect(inA.sort()).toEqual(["g", "p"])
    const outside = retrieve(store, PROJ_B, "which package manager?", Date.now()).map((r) => r.entry.id)
    expect(outside).toEqual(["g"])
  })
})
