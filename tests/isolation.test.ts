import { describe, expect, test } from "bun:test"
import {
  applyConsolidation,
  applySurfaceFeedback,
  applyIrrelevantFeedback,
  applyUsefulFeedback,
  clearProjectEntries,
  consolidationEntries,
  coreSlot,
  emptyStore,
  findWritableTarget,
  prune,
  readableEntries,
  retrieve,
  score,
  type Entry,
  type Store,
} from "../src/core.ts"

const DAY = 24 * 60 * 60 * 1000
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

describe("readableEntries (centralized visibility policy)", () => {
  const store = storeWith([
    entry({ id: "g", text: "global fact" }),
    entry({ id: "a", text: "project A fact", scope: "project", projectID: PROJ_A }),
    entry({ id: "b", text: "project B fact", scope: "project", projectID: PROJ_B }),
    entry({ id: "lo", text: "secret", sensitivity: "local-only" }),
  ])

  test("exposes global entries everywhere, project entries only in their own directory", () => {
    const inA = readableEntries(store, PROJ_A).map((e) => e.id).sort()
    expect(inA).toEqual(["a", "g"])
    const inB = readableEntries(store, PROJ_B).map((e) => e.id).sort()
    expect(inB).toEqual(["b", "g"])
    expect(readableEntries(store, undefined).map((e) => e.id)).toEqual(["g"])
  })

  test("never exposes local-only entries through tool-readable paths", () => {
    for (const dir of [PROJ_A, PROJ_B, undefined]) {
      expect(readableEntries(store, dir).some((e) => e.sensitivity === "local-only")).toBe(false)
    }
  })
})

describe("consolidationEntries (DREAM-visible subset)", () => {
  test("matches readable policy: global + own project, never local-only", () => {
    const store = storeWith([
      entry({ id: "g" }),
      entry({ id: "a", scope: "project", projectID: PROJ_A }),
      entry({ id: "b", scope: "project", projectID: PROJ_B }),
      entry({ id: "lo", sensitivity: "local-only" }),
    ])
    expect(consolidationEntries(store, PROJ_A).map((e) => e.id).sort()).toEqual(["a", "g"])
  })
})

describe("retrieve / coreSlot — cross-project isolation", () => {
  const store = storeWith([
    entry({ id: "a-stack", text: "Project A uses Bun and TypeScript.", scope: "project", projectID: PROJ_A, category: "project" }),
    entry({ id: "b-stack", text: "Project B uses Flask and Python.", scope: "project", projectID: PROJ_B, category: "project" }),
    entry({ id: "g-pref", text: "The user prefers typed languages.", category: "preferences" }),
  ])

  test("a query in project A never surfaces project B memories", () => {
    const ids = retrieve(store, PROJ_A, "what stack does this project use?").map((r) => r.entry.id)
    expect(ids).toContain("a-stack")
    expect(ids).not.toContain("b-stack")
  })

  test("core slot never leaks another project's entries", () => {
    const coreA = entry({ id: "core-a", tier: "core", scope: "project", projectID: PROJ_A })
    const coreB = entry({ id: "core-b", tier: "core", scope: "project", projectID: PROJ_B })
    const s = storeWith([coreA, coreB])
    expect(coreSlot(s, PROJ_A, new Set(), Date.now(), 5).map((e) => e.id)).toEqual(["core-a"])
    expect(coreSlot(s, PROJ_B, new Set(), Date.now(), 5).map((e) => e.id)).toEqual(["core-b"])
    expect(coreSlot(s, undefined, new Set(), Date.now(), 5)).toHaveLength(0)
  })

  test("local-only entries never enter retrieval nor the core slot", () => {
    const s = storeWith([
      entry({ id: "lo", text: "The user's API key is hunter2.", sensitivity: "local-only", tier: "core" }),
    ])
    expect(retrieve(s, PROJ_A, "api key", Date.now(), { excludeSensitivity: new Set(["local-only"]) })).toHaveLength(0)
    expect(coreSlot(s, PROJ_A, new Set(), Date.now(), 3)).toHaveLength(0)
  })
})

describe("findWritableTarget (memory_write dedup targeting)", () => {
  test("rewrites only an entry in the SAME scope and project", () => {
    const store = storeWith([
      entry({ id: "g-bun", text: "The user prefers Bun as runtime.", scope: "global" }),
      entry({ id: "a-bun", text: "The user prefers Bun as runtime.", scope: "project", projectID: PROJ_A }),
    ])
    // Writing the same fact scoped to project B must NOT overwrite A's or the global one.
    expect(findWritableTarget(store.entries, "The user prefers Bun as runtime.", "project", PROJ_B)?.id).toBeUndefined()
    expect(findWritableTarget(store.entries, "The user prefers Bun as runtime.", "project", PROJ_A)?.id).toBe("a-bun")
    expect(findWritableTarget(store.entries, "The user prefers Bun as runtime.", "global", undefined)?.id).toBe("g-bun")
  })

  test("never targets local-only entries", () => {
    const store = storeWith([entry({ id: "lo", text: "The user prefers Bun as runtime.", sensitivity: "local-only" })])
    expect(findWritableTarget(store.entries, "The user prefers Bun as runtime.", "global", undefined)).toBeUndefined()
  })
})

describe("clearProjectEntries (memory_clear scope=project)", () => {
  test("removes only the current project's entries, keeps globals and other projects", () => {
    const store = storeWith([
      entry({ id: "g" }),
      entry({ id: "a", scope: "project", projectID: PROJ_A }),
      entry({ id: "b", scope: "project", projectID: PROJ_B }),
    ])
    const removed = clearProjectEntries(store, PROJ_A)
    expect(removed).toBe(1)
    expect(store.entries.map((e) => e.id).sort()).toEqual(["b", "g"])
  })
})

describe("applyConsolidation — cross-project trust boundary", () => {
  const dreamedB = entry({
    id: "dreamed-b",
    text: "Project B uses Flask.",
    scope: "project",
    projectID: PROJ_B,
    source: "dreamed",
    createdBy: "consolidation",
    weight: 1,
  })
  const explicitB = entry({
    id: "explicit-b",
    text: "Project B deploys on Fly.io.",
    scope: "project",
    projectID: PROJ_B,
    source: "explicit",
  })
  const localOnly = entry({ id: "lo", text: "The user's password is hunter2.", sensitivity: "local-only" })

  test("a dreamed fact from project A must not refresh or rewrite project B's dreamed entry", () => {
    const store = storeWith([{ ...dreamedB }])
    const before = { ...store.entries[0] }
    applyConsolidation(
      store,
      { new: [{ text: "Project B uses Flask and SQLAlchemy.", category: "project", scope: "project" }] },
      PROJ_A,
    )
    const after = store.entries.find((e) => e.id === "dreamed-b")!
    expect(after.text).toBe(before.text)
    expect(after.weight).toBe(before.weight)
    expect(after.lastSeen).toBe(before.lastSeen)
    // ...and must land as its own project-A entry instead.
    const added = store.entries.find((e) => e.text.includes("SQLAlchemy"))
    expect(added?.projectID).toBe(PROJ_A)
  })

  test("a dreamed fact from project A must not suppress project B's explicit entry via similarity or topic clash", () => {
    const store = storeWith([{ ...explicitB }])
    const before = store.entries.length
    applyConsolidation(
      store,
      { new: [{ text: "Project B deploys on Fly.io with zero downtime.", category: "status", scope: "project" }] },
      PROJ_A,
    )
    expect(store.entries.find((e) => e.id === "explicit-b")?.text).toBe(explicitB.text)
    expect(store.entries.some((e) => e.text.includes("zero downtime"))).toBe(true)
    expect(store.entries.length).toBeGreaterThan(before - 1)
  })

  test("update/delete/conflicts by id must ignore entries outside the consolidating project", () => {
    const store = storeWith([{ ...dreamedB }, { ...explicitB }, { ...localOnly }])
    applyConsolidation(
      store,
      {
        update: [{ id: "dreamed-b", text: "hijacked" }],
        delete: ["explicit-b", "lo"],
        conflicts: [{ id: "explicit-b", evidence: "fabricated" }],
      },
      PROJ_A,
    )
    expect(store.entries.find((e) => e.id === "dreamed-b")?.text).toBe(dreamedB.text)
    expect(store.entries.find((e) => e.id === "explicit-b")?.status).toBe("ACTIVE")
    expect(store.entries.find((e) => e.id === "explicit-b")?.conflictAt).toBeUndefined()
    expect(store.entries.find((e) => e.id === "lo")).toBeDefined()
  })

  test("consolidation must never mutate local-only entries even within the same project", () => {
    const store = storeWith([entry({ id: "lo2", text: "Private note", sensitivity: "local-only", source: "dreamed" })])
    applyConsolidation(
      store,
      {
        new: [{ text: "Private note expanded", category: "other" }],
        update: [{ id: "lo2", text: "rewritten" }],
        delete: ["lo2"],
      },
      PROJ_A,
    )
    const lo = store.entries.find((e) => e.id === "lo2")!
    expect(lo.text).toBe("Private note")
    expect(lo.status).toBe("ACTIVE")
    expect(lo.supersededAt).toBeUndefined()
  })
})

describe("surfacing does not refresh factual recency", () => {
  test("applySurfaceFeedback updates exposure fields but never lastSeen", () => {
    const t = Date.now()
    const store = storeWith([entry({ id: "x", lastSeen: t - DAY })])
    applySurfaceFeedback(store, ["x"], t)
    const e = store.entries[0]
    expect(e.lastSeen).toBe(t - DAY)
    expect(e.lastSurfaced).toBe(t)
    expect(e.surfacedCount).toBe(1)
    expect(score(e, t + 45 * DAY)).toBeLessThan(score(entry({ id: "y", lastSeen: t }), t))
  })

  test("surface feedback is debounced per interval", () => {
    const t = Date.now()
    const store = storeWith([entry({ id: "x", lastSeen: t - DAY })])
    applySurfaceFeedback(store, ["x"], t)
    applySurfaceFeedback(store, ["x"], t + 1000, 15 * 60 * 1000)
    expect(store.entries[0].surfacedCount).toBe(1)
    applySurfaceFeedback(store, ["x"], t + 16 * 60 * 1000, 15 * 60 * 1000)
    expect(store.entries[0].surfacedCount).toBe(2)
  })

  test("frequent exposure alone cannot keep an entry above the prune floor forever", () => {
    const t = Date.now()
    const store = storeWith([entry({ id: "x", lastSeen: t, weight: 1, source: "dreamed" })])
    for (let d = 0; d <= 200; d += 15) {
      applySurfaceFeedback(store, ["x"], t + d * DAY, 1)
    }
    prune(store, t + 200 * DAY)
    expect(store.entries.find((e) => e.id === "x")).toBeUndefined()
  })

  test("explicit positive feedback IS treated as confirmation (refreshes lastSeen)", () => {
    const t = Date.now()
    const store = storeWith([entry({ id: "x", lastSeen: t - 30 * DAY })])
    expect(applyUsefulFeedback(store, "x", t)).toBe(true)
    expect(store.entries[0].lastSeen).toBe(t)
    expect(store.entries[0].helpfulCount).toBe(1)
  })

  test("negative feedback never refreshes lastSeen", () => {
    const t = Date.now()
    const store = storeWith([entry({ id: "x", lastSeen: t - 30 * DAY })])
    expect(applyIrrelevantFeedback(store, "x", t)).toBe(true)
    expect(store.entries[0].lastSeen).toBe(t - 30 * DAY)
    expect(store.entries[0].irrelevantCount).toBe(1)
  })

  test("feedback helpers refuse unknown ids", () => {
    const store = storeWith([entry({ id: "x" })])
    expect(applyUsefulFeedback(store, "missing", Date.now())).toBe(false)
    expect(applyIrrelevantFeedback(store, "missing", Date.now())).toBe(false)
  })
})
