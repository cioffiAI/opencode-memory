import { describe, expect, test } from "bun:test"
import { addEntry, emptyStore, normalizeStore, prune, score } from "../src/core.ts"

const DAY = 24 * 60 * 60 * 1000

function entry(overrides: Partial<Parameters<typeof score>[0]> = {}) {
  return {
    id: "e1",
    text: "The user likes coffee.",
    category: "preferences",
    scope: "global" as const,
    weight: 3,
    created: Date.now(),
    lastSeen: Date.now(),
    source: "explicit" as const,
    ...overrides,
  }
}

describe("normalizeStore", () => {
  test("migrates legacy 'general' category to 'other'", () => {
    const store = emptyStore()
    store.entries = [{ ...entry(), category: "general" }]
    const out = normalizeStore(store)
    expect(out.entries[0].category).toBe("other")
  })

  test("falls back to 'other' for unknown categories", () => {
    const store = emptyStore()
    store.entries = [{ ...entry(), category: "not-a-category" }]
    const out = normalizeStore(store)
    expect(out.entries[0].category).toBe("other")
  })

  test("keeps valid categories untouched", () => {
    const store = emptyStore()
    store.entries = [{ ...entry(), category: "workflow" }]
    const out = normalizeStore(store)
    expect(out.entries[0].category).toBe("workflow")
  })

  test("rejects unsupported store versions", () => {
    const store = { ...emptyStore(), version: 99 } as never
    expect(normalizeStore(store)).toEqual(emptyStore())
  })
})

describe("addEntry", () => {
  test("assigns id and created timestamp", () => {
    const store = emptyStore()
    addEntry(store, {
      text: "The user prefers TypeScript.",
      category: "preferences",
      scope: "global",
      weight: 1,
      lastSeen: 0,
      source: "dreamed",
    })
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].id).toBeTruthy()
    expect(store.entries[0].created).toBeGreaterThan(0)
  })
})

describe("score", () => {
  test("explicit entries rank above dreamed with same weight", () => {
    const t = Date.now()
    const dreamed = score(entry({ source: "dreamed", weight: 3 }), t)
    const explicit = score(entry({ source: "explicit", weight: 3 }), t)
    expect(explicit).toBeGreaterThan(dreamed)
  })

  test("fresh entries rank above old ones (recency decay)", () => {
    const t = Date.now()
    const fresh = score(entry({ lastSeen: t }), t)
    const old = score(entry({ lastSeen: t - 90 * DAY }), t)
    expect(fresh).toBeGreaterThan(old)
  })
})

describe("prune", () => {
  test("removes entries whose weight decays below the floor", () => {
    const t = Date.now()
    const store = emptyStore()
    store.entries = [
      { ...entry({ id: "fresh", lastSeen: t }) },
      { ...entry({ id: "stale", weight: 0.5, lastSeen: t - 400 * DAY, source: "dreamed" }) },
    ]
    prune(store, t)
    const ids = store.entries.map((e) => e.id)
    expect(ids).toContain("fresh")
    expect(ids).not.toContain("stale")
  })
})
