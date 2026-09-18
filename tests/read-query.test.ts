// memory_read query semantics (issue #4).
//
// src/core.ts readQuery(): the legacy contiguous substring path is preserved
// and a whole-token AND path is added for multi-word queries. Grammar choices
// (technical identifiers, accents, separators, camelCase) are documented and
// tested in the `queryTermGroups grammar` block below.
import { describe, expect, test } from "bun:test"
import { emptyStore, queryTermGroups, readQuery, type Entry, type Store } from "../src/core.ts"

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

function found(text: string, query: string, category = "other"): boolean {
  return readQuery(storeWith([entry({ text, category })]), PROJ_A, { query }).length === 1
}

// The expected column encodes the contract: legacy matches stay, short and
// technical terms are never dropped, token boundaries are sacred.
const CONTRACT: Array<{ name: string; text: string; query: string; expected: boolean; category?: string }> = [
  // issue #4: all terms, any order, non-contiguous
  { name: "issue example: coffee morning", text: "The user prefers to drink coffee in the morning.", query: "coffee morning", expected: true },
  { name: "reverse order", text: "The user prefers to drink coffee in the morning.", query: "morning coffee", expected: true },
  { name: "tab separated query", text: "Coffee is served in the morning.", query: "coffee\tmorning", expected: true },
  { name: "multiple spaces", text: "Coffee is served in the morning.", query: "coffee   morning", expected: true },
  { name: "comma separated query", text: "Coffee is served in the morning.", query: "coffee, morning", expected: true },
  { name: "case insensitive", text: "COFFEE is served each MORNING.", query: "Coffee Morning", expected: true },
  { name: "required word missing", text: "The user likes coffee.", query: "coffee afternoon", expected: false },

  // legacy path preserved exactly
  { name: "single word", text: "The user likes coffee.", query: "coffee", expected: true },
  { name: "legacy partial word still matches", text: "The user likes coffee.", query: "coff", expected: true },
  { name: "legacy exact phrase", text: "The user prefers to drink coffee in the morning.", query: "coffee in the morning", expected: true },
  { name: "empty query returns everything", text: "A stored fact.", query: "", expected: true },
  { name: "whitespace query returns everything", text: "A stored fact.", query: "   ", expected: true },
  { name: "punctuation-only query does not match everything", text: "A stored fact.", query: "???", expected: false },
  { name: "punctuation legacy substring", text: "The marker is ??? here.", query: "???", expected: true },

  // short terms are terms (the issue patch dropped them)
  { name: "AI is not dropped", text: "AI research and UI work.", query: "AI UI", expected: true },
  { name: "AI does not match statistical", text: "The user builds statistical models.", query: "AI models", expected: false },
  { name: "AI does not match daily", text: "Daily weather models are useful.", query: "AI models", expected: false },
  { name: "UI does not match design", text: "The user prefers minimalist design.", query: "UI design", expected: false },
  { name: "C is not dropped", text: "C is the language; the compiler is clang.", query: "C compiler", expected: true },
  { name: "C does not match Rust compiler", text: "The user prefers the Rust compiler.", query: "C compiler", expected: false },
  { name: "DB does not match migrations", text: "These are folder migrations.", query: "DB migrations", expected: false },
  { name: "R does not match Rust", text: "Rust is used for all jobs.", query: "R jobs", expected: false },
  { name: "no is not dropped", text: "User likes coffee.", query: "no coffee", expected: false },

  // token boundaries in the fallback
  { name: "cat does not match education", text: "The user works on education design.", query: "cat design", expected: false },

  // technical identifiers
  { name: "C++ matches", text: "C++ is the chosen language.", query: "C++ language", expected: true },
  { name: "C# matches", text: "C# is the chosen language.", query: "C# language", expected: true },
  { name: "C# does not match C++", text: "C++ is the chosen language.", query: "C# language", expected: false },
  { name: "C++ does not match C#", text: "C# is the chosen language.", query: "C++ language", expected: false },
  { name: "Node.js matches", text: "Node.js is the chosen runtime.", query: "Node.js runtime", expected: true },
  { name: ".NET matches", text: ".NET is our chosen framework.", query: ".NET framework", expected: true },
  { name: "camelCase identifier splits", text: "The userStore caches sessions.", query: "user store", expected: true },
  { name: "snake_case identifier splits", text: "The flag is OPENCODE_MEMORY_DIR.", query: "memory dir", expected: true },
  { name: "hyphenated compound splits", text: "The user builds AI-powered tools.", query: "AI tools", expected: true },

  // identifier case symmetry (query and memory go through the same grammar)
  { name: "camelCase query against separated words", text: "The user store caches sessions.", query: "userStore", expected: true },
  { name: "camelCase query with another term", text: "The userStore caches sessions.", query: "userStore sessions", expected: true },
  { name: "camelCase identifier in a multi-word query", text: "JavaScript is my preferred language.", query: "JavaScript language", expected: true },
  { name: "lowercase query against camelCase memory", text: "JavaScript is my preferred language.", query: "javascript language", expected: true },
  { name: "uppercase query against camelCase memory", text: "JavaScript is my preferred language.", query: "JAVASCRIPT language", expected: true },
  { name: "mixed-case query against lowercase memory", text: "javascript is my preferred language.", query: "JavaScript language", expected: true },
  { name: "single camelCase word matches its compact form", text: "JavaScript is my preferred language.", query: "JavaScript", expected: true },
  { name: "all identifier parts must be present", text: "The user writes java code.", query: "JavaScript language", expected: false },

  // category is a match surface for terms too
  { name: "query matches text and category together", text: "The user likes coffee.", query: "coffee preferences", expected: true, category: "preferences" },
  { name: "legacy category substring", text: "A stored fact.", query: "pref", expected: true, category: "preferences" },

  // accents: whole words match, folding is not introduced
  { name: "unicode words match", text: "Il caffè viene bevuto ogni mattina.", query: "caffè mattina", expected: true },
  { name: "accent folding not introduced", text: "Il caffè viene bevuto ogni mattina.", query: "caffe mattina", expected: false },
]

describe("memory_read multi-term contract (issue #4)", () => {
  for (const c of CONTRACT) {
    test(c.name, () => {
      expect(found(c.text, c.query, c.category ?? "other")).toBe(c.expected)
    })
  }
})

describe("readQuery multi-term selection", () => {
  test("returns every entry containing all terms, sorted by score", () => {
    const store = storeWith([
      entry({ id: "a", text: "Coffee is served in the morning.", weight: 2 }),
      entry({ id: "b", text: "Morning coffee is a ritual.", weight: 4 }),
      entry({ id: "c", text: "The user likes coffee.", weight: 3 }),
    ])
    expect(readQuery(store, PROJ_A, { query: "coffee morning" }).map((e) => e.id)).toEqual(["b", "a"])
  })

  test("an entry missing one term is not returned", () => {
    const store = storeWith([
      entry({ id: "a", text: "Coffee is served in the morning." }),
      entry({ id: "c", text: "The user likes coffee." }),
    ])
    expect(readQuery(store, PROJ_A, { query: "coffee morning" }).map((e) => e.id)).toEqual(["a"])
  })
})

describe("readQuery multi-term keeps privacy and filters intact", () => {
  const store = storeWith([
    entry({ id: "g", text: "The user drinks coffee in the morning." }),
    entry({ id: "a", text: "Project A deploys every morning.", category: "project", scope: "project", projectID: PROJ_A }),
    entry({ id: "b", text: "Project B uses Flask in the morning.", category: "project", scope: "project", projectID: PROJ_B }),
    entry({ id: "lo", text: "The API token is rotated every morning.", sensitivity: "local-only" }),
  ])

  test("all-terms queries never cross project boundaries", () => {
    expect(readQuery(store, PROJ_A, { query: "flask morning" }).map((e) => e.id)).toEqual([])
    expect(readQuery(store, PROJ_A, { query: "coffee morning" }).map((e) => e.id)).toEqual(["g"])
    expect(readQuery(store, PROJ_A, { query: "deploys morning" }).map((e) => e.id)).toEqual(["a"])
  })

  test("local-only entries are never returned, even for all-terms queries", () => {
    expect(readQuery(store, PROJ_A, { query: "api morning" })).toHaveLength(0)
    expect(readQuery(store, PROJ_A, { query: "token rotated" })).toHaveLength(0)
  })

  test("scope and category filters still apply after the query path", () => {
    expect(readQuery(store, PROJ_A, { query: "morning", scope: "project" }).map((e) => e.id)).toEqual(["a"])
    expect(readQuery(store, PROJ_A, { query: "morning", category: "preferences" }).map((e) => e.id)).toEqual(["g"])
    expect(readQuery(store, PROJ_A, { query: "deploys morning", scope: "global" })).toHaveLength(0)
  })

  test("readQuery never mutates the store", () => {
    const before = JSON.stringify(store)
    readQuery(store, PROJ_A, { query: "coffee morning" })
    expect(JSON.stringify(store)).toBe(before)
  })
})

describe("queryTermGroups grammar (documented, tested choices)", () => {
  test("technical identifiers stay distinct", () => {
    expect(queryTermGroups("C++ C# Node.js .NET").map((g) => g.whole)).toEqual(["c++", "c#", "node.js", "net"])
  })

  test("separators split terms; punctuation-only fragments disappear", () => {
    expect(queryTermGroups("coffee, morning\tAI-powered memory_read ???").map((g) => g.whole)).toEqual([
      "coffee",
      "morning",
      "ai",
      "powered",
      "memory",
      "read",
    ])
  })

  test("camelCase keeps the compact form and the parts as alternatives", () => {
    expect(queryTermGroups("userStore")).toEqual([{ whole: "userstore", parts: ["user", "store"] }])
  })

  test("plain words have a single form", () => {
    expect(queryTermGroups("coffee")).toEqual([{ whole: "coffee", parts: ["coffee"] }])
  })

  test("accents are preserved, not folded", () => {
    expect(queryTermGroups("caffè caffè").map((g) => g.whole)).toEqual(["caffè"])
  })
})
