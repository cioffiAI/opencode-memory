import { describe, expect, test } from "bun:test"
import {
  applyConsolidation,
  emptyStore,
  expandTopicKeywords,
  findSimilar,
  norm,
  similarity,
  topicClash,
  tokens,
} from "../src/core.ts"

function entry(overrides: Partial<any> = {}) {
  return {
    id: "e1",
    text: "The user's favorite color is green.",
    category: "preferences",
    scope: "global" as const,
    weight: 3,
    created: Date.now(),
    lastSeen: Date.now(),
    source: "explicit" as const,
    ...overrides,
  }
}

describe("norm / tokens", () => {
  test("lowercases, strips accents and punctuation", () => {
    expect(norm("L'Utente Preferisce IL VERDE!")).toBe("l utente preferisce il verde")
    expect(norm("perché due parole")).toBe("perche due parole")
  })

  test("tokens splits on whitespace", () => {
    expect(tokens("The user codes in Rust")).toHaveLength(5)
  })
})

describe("similarity / findSimilar", () => {
  test("identical texts score 1, unrelated texts score 0", () => {
    expect(similarity("The user likes green", "the user likes green")).toBe(1)
    expect(similarity("The user likes green", "Rust programs compile fast")).toBe(0)
  })

  test("findSimilar matches a subset of words", () => {
    const entries = [entry({ text: "The user prefers Rust over Go." })]
    expect(findSimilar(entries, "The user prefers Rust")).toBeDefined()
    expect(findSimilar(entries, "The user loves hiking")).toBeUndefined()
  })
})

describe("topicClash", () => {
  test("detects shared content words (>= 4 chars)", () => {
    expect(topicClash("The user codes in Rust", "L'utente scrive codice in Rust")).toBe(true)
    expect(topicClash("The user likes green", "L'utente preferisce il rosso")).toBe(false)
  })
})

describe("expandTopicKeywords", () => {
  test("expands 'linguaggi' to English forms incl. 'code'", () => {
    const out = expandTopicKeywords(["linguaggi"])
    expect(out).toContain("code")
    expect(out).toContain("codice")
    expect(out).toContain("language")
  })

  test("expands 'sistema' to 'system'", () => {
    const out = expandTopicKeywords(["sistema"])
    expect(out).toContain("system")
  })

  test("keeps keywords without a synonym group", () => {
    const out = expandTopicKeywords(["green"])
    expect(out).toContain("green")
    expect(out).toHaveLength(1)
  })
})

describe("applyConsolidation — source hierarchy", () => {
  test("never adds a new fact equivalent to an explicit entry", () => {
    const store = emptyStore()
    store.entries = [entry()]
    const before = store.entries.length
    applyConsolidation(store, { new: [{ text: "The user's favorite color is green.", category: "preferences" }] }, undefined)
    expect(store.entries).toHaveLength(before)
  })

  test("never applies update to an explicit entry", () => {
    const store = emptyStore()
    store.entries = [entry()]
    applyConsolidation(store, { update: [{ id: "e1", text: "The user's favorite color is red." }] }, undefined)
    expect(store.entries[0].text).toBe("The user's favorite color is green.")
  })

  test("never deletes an explicit entry", () => {
    const store = emptyStore()
    store.entries = [entry()]
    applyConsolidation(store, { delete: ["e1"] }, undefined)
    expect(store.entries).toHaveLength(1)
  })

  test("refreshes a dreamed entry on dedup instead of duplicating", () => {
    const store = emptyStore()
    store.entries = [entry({ source: "dreamed", text: "The user codes in Rust.", weight: 1 })]
    applyConsolidation(store, { new: [{ text: "The user codes in Rust.", category: "preferences" }] }, undefined)
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0].source).toBe("dreamed")
    expect(store.entries[0].weight).toBeGreaterThan(1)
  })

  test("skips a new fact that clashes with an explicit entry in the same category", () => {
    const store = emptyStore()
    store.entries = [entry({ text: "The user codes in Rust." })]
    const before = store.entries.length
    applyConsolidation(store, { new: [{ text: "L'utente scrive codice in Rust.", category: "preferences" }] }, undefined)
    expect(store.entries).toHaveLength(before)
  })

  test("adds genuinely new dreamed facts and writes the summary", () => {
    const store = emptyStore()
    store.entries = [entry({ text: "The user's favorite color is green." })]
    applyConsolidation(
      store,
      {
        new: [{ text: "The user prefers TypeScript over JavaScript.", category: "preferences" }],
        summary: "The user likes green and TypeScript.",
      },
      undefined,
    )
    expect(store.entries).toHaveLength(2)
    expect(store.entries[1].source).toBe("dreamed")
    expect(store.summary).toContain("TypeScript")
  })

  test("honours scope 'project' and attaches projectID", () => {
    const store = emptyStore()
    applyConsolidation(store, { new: [{ text: "This codebase uses Rust.", category: "project", scope: "project" }] }, "/work/repo")
    expect(store.entries[0].scope).toBe("project")
    expect(store.entries[0].projectID).toBe("/work/repo")
  })
})
