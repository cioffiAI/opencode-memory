import { describe, expect, test } from "bun:test"
import {
  emptyStore,
  expandTopicKeywordsDetailed,
  passesRelevanceGate,
  retrieve,
  topicKeywords,
  type Entry,
  type RankedMemory,
  type Store,
} from "../src/core.ts"

// v1.6 retrieval semantics regression tests.
//
// These encode the token-boundary matcher and the redesigned synonym policy.
// Tests in "confirmed bugs" FAILED against v1.5.1 behavior (substring/prefix
// matching, opinion-verb synonym expansion); protection tests guard useful
// bilingual/morphological recall that must survive the tightening.

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "e1",
    text: "fact",
    category: "other",
    scope: "global",
    weight: 2,
    created: Date.now(),
    lastSeen: Date.now(),
    source: "dreamed",
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

function surfaceable(store: Store, query: string): RankedMemory[] {
  // mirrors buildMemoryBlock's lexical path: relevance tier = gate-passing candidates
  return retrieve(store, undefined, query, Date.now(), { excludeSensitivity: new Set(["local-only"]) }).filter(passesRelevanceGate)
}

describe("confirmed substring bugs (failed on v1.5.1)", () => {
  test("'use' inside 'user' must not make an editor memory surface for a refactor request (cn-02)", () => {
    const store = storeWith([entry({ id: "nvim", text: "The user's editor is Neovim." })])
    expect(surfaceable(store, "refactor the auth middleware to use async/await")).toHaveLength(0)
  })

  test("'test' inside 'pytest' must not match (identifier trap)", () => {
    const store = storeWith([entry({ id: "ci", text: "The CI pipeline runs pytest with coverage reports." })])
    expect(surfaceable(store, "add a test for the checkout flow")).toHaveLength(0)
  })

  test("'test' inside 'greatest' must not match", () => {
    const store = storeWith([entry({ id: "playlist", text: "The user's greatest hits playlist has 100 songs." })])
    expect(surfaceable(store, "write integration tests for payments")).toHaveLength(0)
  })

  test("'red' inside 'redesign' must not match", () => {
    const store = storeWith([entry({ id: "car", text: "The user's car is red." })])
    expect(surfaceable(store, "redesign the report layout")).toHaveLength(0)
  })
})

describe("confirmed synonym-overreach bugs (failed on v1.5.1)", () => {
  test("a color question must not bridge through opinion verbs to unrelated favorites (fp-05)", () => {
    const store = storeWith([entry({ id: "roastery", text: "The user's favorite coffee is from the green roastery." })])
    expect(surfaceable(store, "what color theme does the user prefer in the IDE?")).toHaveLength(0)
  })

  test("domain nouns never expand to opinion verbs (fp-05 class)", () => {
    const expanded = expandTopicKeywordsDetailed(["color"]).map((x) => x.term)
    expect(expanded).toEqual(["color", "colors", "colore", "colori"])
    expect(expanded).not.toContain("favorite")
    expect(expanded).not.toContain("like")
    // ...while direct morphological bridging of the verb itself survives
    expect(topicKeywords("does the user prefer tabs?")).toContain("prefer")
  })
})

describe("protected morphological recall (must keep working)", () => {
  test("singular query keyword matches plural entry token and vice versa", () => {
    const store = storeWith([
      entry({ id: "vercel", text: "The user deploys on Vercel.", category: "status" }),
      entry({ id: "commits", text: "The user runs tests before every commit.", category: "preferences" }),
    ])
    const r1 = surfaceable(store, "where does the user deploy and what database?")
    expect(r1.map((r) => r.entry.id)).toContain("vercel")
    const r2 = surfaceable(store, "does the user run tests before pushing?")
    expect(r2.map((r) => r.entry.id)).toContain("commits")
    const kinds = r1.find((r) => r.entry.id === "vercel")!.matches.map((m) => m.kind)
    expect(kinds.every((k) => ["exact", "inflection", "category"].includes(k))).toBe(true)
  })

  test("gerund/participle inflections match (network -> networking)", () => {
    const store = storeWith([entry({ id: "net", text: "The user is fixing a networking issue with the router.", category: "status" })])
    const r = surfaceable(store, "quali problemi di rete ha l'utente?")
    expect(r.map((x) => x.entry.id)).toContain("net")
  })
})

describe("protected bilingual recall (must keep working)", () => {
  test("colore <-> color translation still bridges (sy-01 class)", () => {
    const store = storeWith([entry({ id: "green", text: "The user's favorite color is green.", category: "preferences" })])
    const r = surfaceable(store, "quale colore piace all'utente?")
    expect(r.map((x) => x.entry.id)).toContain("green")
  })

  test("job <-> lavoro translation still bridges (sy-10 class)", () => {
    const store = storeWith([entry({ id: "jobit", text: "L'utente cerca un nuovo lavoro nel settore AI.", category: "status" })])
    const r = surfaceable(store, "is the user looking for a new job?")
    expect(r.map((x) => x.entry.id)).toContain("jobit")
  })

  test("security <-> sicurezza translation still bridges", () => {
    const store = storeWith([entry({ id: "sec", text: "The user studies web security at university.", category: "status" })])
    const r = surfaceable(store, "quali argomenti di sicurezza studia l'utente?")
    expect(r.map((x) => x.entry.id)).toContain("sec")
  })
})

describe("identifier boundaries (developer vocabulary)", () => {
  test("camelCase identifiers split into word-boundary tokens on BOTH sides", () => {
    const store = storeWith([entry({ id: "us", text: "Session state lives in the userStore module.", category: "project" })])
    const r = surfaceable(store, "where does userStore keep session state?")
    expect(r.map((x) => x.entry.id)).toContain("us")
    const m = r.find((x) => x.entry.id === "us")!
    expect(m.matches.every((x) => ["exact", "inflection", "category"].includes(x.kind))).toBe(true)
  })

  test("snake_case and kebab-case split into boundary tokens", () => {
    const store = storeWith([
      entry({ id: "snake", text: "Retry logic lives in retry_helper.py.", category: "project" }),
      entry({ id: "kebab", text: "Styles are loaded from app-theme.css.", category: "project" }),
    ])
    expect(surfaceable(store, "update the retry helper").map((x) => x.entry.id)).toContain("snake")
    expect(surfaceable(store, "change the app theme colors").map((x) => x.entry.id)).toContain("kebab")
  })
})

describe("relevance gate is a named, single-source policy", () => {
  test("entries without keyword support never pass the lexical gate", () => {
    const ranked: RankedMemory[] = [
      { entry: entry({ id: "a" }), base: 3, keywordHits: 0, matches: [], core: false, rank: 1, final: 3 },
      {
        entry: entry({ id: "b" }),
        base: 2,
        keywordHits: 1,
        matches: [{ keyword: "database", kind: "exact", direct: true }],
        core: false,
        rank: 2,
        final: 5,
      },
    ]
    expect(ranked.filter(passesRelevanceGate).map((r) => r.entry.id)).toEqual(["b"])
  })
})
