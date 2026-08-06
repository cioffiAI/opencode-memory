// Pure logic of opencode-memory, kept free of opencode runtime dependencies so
// it can be unit-tested directly. The plugin entrypoint (index.ts) imports
// from here; nothing of this module is re-exported from the entrypoint.

export type Entry = {
  id: string
  text: string
  category: string
  scope: "global" | "project"
  projectID?: string
  weight: number
  created: number
  lastSeen: number
  source: "explicit" | "dreamed"
}

export type Store = {
  version: 1
  summary: string
  updatedAt: number
  entries: Entry[]
}

export const DAY = 24 * 60 * 60 * 1000

// Single source of truth for categories. "other" is the fallback category;
// "general" is NOT a valid category (legacy entries with that value are
// normalized to "other" on read, see normalizeStore).
export const CATEGORIES = ["user", "project", "workflow", "preferences", "decisions", "status", "environment", "other"]

export function emptyStore(): Store {
  return { version: 1, summary: "", updatedAt: 0, entries: [] }
}

export function normalizeStore(store: Store): Store {
  if (store.version !== 1) return emptyStore()
  for (const e of store.entries) {
    if (e.category === "general") e.category = "other"
    if (!CATEGORIES.includes(e.category)) e.category = "other"
  }
  return store
}

export function score(entry: Entry, t = Date.now()): number {
  const days = Math.max(0, (t - entry.lastSeen) / DAY)
  const sourceBonus = entry.source === "explicit" ? 0.5 : 0
  return (entry.weight + sourceBonus) * Math.exp(-days / 45)
}

export function norm(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function tokens(text: string): string[] {
  return norm(text)
    .split(/\s+/)
    .filter(Boolean)
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.length === 0 || tb.length === 0) return 0
  const set = new Set(tb)
  const overlap = ta.filter((t) => set.has(t)).length
  return overlap / Math.min(ta.length, tb.length)
}

export function findSimilar(entries: Entry[], text: string, threshold = 0.6): Entry | undefined {
  const n = norm(text)
  return entries.find(
    (e) =>
      similarity(e.text, text) >= threshold ||
      (n.length > 3 && n.includes(norm(e.text))) ||
      (norm(e.text).length > 3 && norm(e.text).includes(n)),
  )
}

// Content-word overlap (tokens >= 4 chars), used as a topic-level guard
// against duplicates that plain token similarity misses across languages.
// Stopwords (common EN/IT verbs, pronouns and function words) are excluded
// to avoid false clashes between unrelated facts that merely share words
// like "user" or "like".
const CLASH_STOPWORDS = new Set([
  "user", "users", "like", "likes", "want", "wants", "need", "needs", "use", "uses", "used", "using",
  "write", "writes", "wrote", "work", "works", "worked", "working", "would", "could", "should",
  "this", "that", "these", "those", "with", "from", "have", "has", "they", "them", "their", "your",
  "its", "about", "when", "what", "there", "make", "makes", "get", "gets",
  "utente", "utenti", "vorrebbe", "vuole", "serve", "servono", "usa", "usare", "usato", "usando",
  "scrive", "scrivere", "scritto", "lavora", "lavorare", "lavorando", "questo", "questa",
  "quello", "quella", "con", "per", "della", "degli", "delle", "della", "nella", "nelle", "dei",
  "che", "chi", "come", "cosa", "fare", "fatto", "fare", "dopo", "prima", "solo", "anche",
])
export function topicClash(a: string, b: string): boolean {
  const ta = tokens(a)
    .filter((t) => t.length >= 4)
    .filter((t) => !CLASH_STOPWORDS.has(t))
  const tb = tokens(b)
    .filter((t) => t.length >= 4)
    .filter((t) => !CLASH_STOPWORDS.has(t))
  if (ta.length === 0 || tb.length === 0) return false
  const set = new Set(tb)
  return ta.some((t) => set.has(t))
}

export function addEntry(store: Store, e: Omit<Entry, "id" | "created"> & { created?: number }) {
  store.entries.push({
    ...e,
    id: crypto.randomUUID(),
    created: e.created ?? Date.now(),
  })
}

export function prune(store: Store, t = Date.now(), maxEntries = 400) {
  for (const e of store.entries) e.weight *= Math.exp(-(t - e.lastSeen) / 45 / DAY)
  store.entries.sort((a, b) => score(b, t) - score(a, t))
  store.entries = store.entries.filter((e) => e.weight >= 0.15).slice(0, maxEntries)
}

export type LogLevel = "debug" | "info" | "warn" | "error"

export function applyConsolidation(
  store: Store,
  parsed: { new?: any[]; update?: any[]; delete?: string[]; summary?: string },
  projectID: string | undefined,
  t = Date.now(),
  log?: (level: LogLevel, message: string, extra?: Record<string, unknown>) => void,
) {
  for (const item of parsed.new ?? []) {
    if (!item || typeof item.text !== "string" || !item.text.trim()) continue
    const text = item.text.trim()
    const scope: Entry["scope"] = item.scope === "project" ? "project" : "global"
    const category = typeof item.category === "string" && CATEGORIES.includes(item.category) ? item.category : "other"
    const existing = findSimilar(store.entries, text, 0.5)
    if (existing) {
      // Source hierarchy: explicit (user-stated) always wins. Never
      // duplicate or rewrite it from an inference.
      if (existing.source === "explicit") {
        log?.("debug", "dedup skipped (explicit wins)", { text, existingId: existing.id })
        continue
      }
      existing.text = text
      existing.weight = Math.min(4, existing.weight + 0.5)
      existing.lastSeen = t
      if (scope === "project" && !existing.projectID) existing.projectID = projectID
    } else {
      // Topic-level guard: same category + shared content word → treat as
      // duplicate of an explicit fact even across languages.
      const clash = store.entries.find(
        (e) => e.source === "explicit" && e.category === category && topicClash(e.text, text),
      )
      if (clash) {
        log?.("debug", "dedup skipped (topic clash with explicit)", { text, existingId: clash.id })
        continue
      }
      addEntry(store, {
        text,
        category,
        scope,
        projectID: scope === "project" ? projectID : undefined,
        weight: 1,
        lastSeen: t,
        source: "dreamed",
        created: t,
      })
    }
  }
  for (const item of parsed.update ?? []) {
    if (!item || typeof item.text !== "string" || !item.text.trim()) continue
    const target = item.id ? store.entries.find((e) => e.id === item.id) : item.match ? findSimilar(store.entries, String(item.match)) : undefined
    // Inferences never rewrite explicit facts: only memory_update/forget do.
    if (target && target.source !== "explicit") {
      target.text = item.text.trim()
      target.weight = Math.min(4, target.weight + 0.5)
      target.lastSeen = t
    }
  }
  for (const item of parsed.delete ?? []) {
    if (typeof item !== "string") continue
    const del = item.trim()
    store.entries = store.entries.filter(
      (e) => e.source === "explicit" || (e.id !== del && !(del.length > 3 && e.text.toLowerCase().includes(del.toLowerCase()))),
    )
  }
  if (typeof parsed.summary === "string" && parsed.summary.trim()) {
    store.summary = parsed.summary.trim().slice(0, 3000)
  }
  store.updatedAt = t
}

const STOPWORDS = new Set([
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "a", "da", "in", "con", "su", "per", "tra", "fra",
  "che", "e", "o", "ma", "se", "come", "quando", "cosa", "chi", "dove", "perche", "anche", "non", "piu", "mi", "ti",
  "si", "ci", "vi", "the", "an", "and", "or", "but", "of", "to", "in", "for", "with", "on", "at", "by", "is", "are",
  "was", "were", "be", "do", "does", "did", "what", "who", "how", "why", "when", "where", "i", "you", "he", "she",
  "it", "we", "they", "my", "your", "our", "their", "this", "that", "please", "ciao", "hello", "hi", "ok", "grazie",
  "thanks", "can", "could", "would", "should", "will", "want", "need", "vorrei", "puoi", "potresti", "mio", "mia",
  "miei", "mie", "tuo", "tua", "tuoi", "tue", "suo", "sua", "sono", "era", "ero", "voglio", "posso", "fai", "fare",
  "fammi", "dimmi", "sai", "so", "parliamo", "abbiamo", "avrei", "sarebbe", "della", "dello", "delle", "degli",
  "alla", "allo", "alle", "agli", "nel", "nella", "nello", "nelle", "negli", "dal", "dalla", "dallo", "dalle",
  "dagli", "sul", "sulla", "sullo", "sulle", "sugli", "perche'", "come", "molto", "troppo", "qualcosa", "cosa",
  "posso", "ti", "vi", "ci", "lo", "la", "le", "li", "ne", "egli", "ella", "essi", "esse", "questo", "questa",
  "quello", "quella", "quelli", "quelle", "sto", "sta", "stai", "state", "siamo", "essere", "avere", "fare", "dire",
  "andare", "venire", "prendere", "vedere", "volere", "potere", "dovere", "sapere", "mettere", "lasciare", "trovare",
  "uscire", "entrare", "i", "you", "we", "they", "he", "she", "it", "me", "us", "them", "him", "her", "my", "your",
  "our", "their", "this", "that", "these", "those", "please", "hello", "hi", "ok", "thanks", "thank", "there",
  "their", "about", "into", "onto", "over", "under", "between", "from", "after", "before", "during", "against",
])

// Permanent core: operative preferences always surfaced regardless of topic.
export const CORE_CATEGORIES = new Set(["preferences", "workflow", "decisions", "environment"])

export function topicKeywords(text: string): string[] {
  return tokens(text).filter((t) => t.length > 2 && !STOPWORDS.has(t))
}

// Bilingual synonym groups bridge the gap between semantic dedup (LLM) and
// lexical retrieval without embeddings: a topic query about "linguaggi di
// sistema" must also match a memory written as "the user codes in Rust".
const SYNONYM_GROUPS: string[][] = [
  ["language", "languages", "linguaggio", "linguaggi", "code", "codice", "coding", "programmazione", "programming"],
  ["system", "systems", "sistema", "sistemi", "platform", "piattaforma"],
  ["color", "colors", "colore", "colori", "favorite", "favourite", "preferito", "preferita", "preferisce", "preferisci", "like", "loves", "ama", "piace", "piacciono"],
  ["database", "databases", "db", "banca", "dati"],
  ["plugin", "plugins", "estensione", "estensioni", "extension", "extensions", "addon", "addons"],
  ["app", "apps", "application", "applications", "applicazione", "applicazioni"],
  ["web", "website", "websites", "sito", "siti", "pagina", "pagine"],
  ["test", "tests", "testing", "testare", "verifica", "verifiche", "verificare"],
  ["bug", "bugs", "error", "errors", "errore", "errori", "issue", "issues"],
  ["os", "operating", "sistema operativo"],
  ["memory", "memoria", "remember", "ricordare", "ricordi", "ricorda"],
  ["work", "works", "job", "jobs", "lavoro", "lavorare", "lavora", "lavori", "career", "carriera"],
  ["server", "servers", "hosting"],
  ["network", "networks", "rete", "reti", "networking"],
  ["security", "sicurezza", "secure", "sicuro", "privacy"],
  ["design", "designer", "progettazione", "progettare", "progetto", "projects", "project"],
  ["database", "data", "dataset", "dati"],
]

// Expand topic keywords with all forms of their bilingual synonym group.
export function expandTopicKeywords(keywords: string[]): string[] {
  const out = new Set<string>(keywords)
  for (const k of keywords) {
    for (const group of SYNONYM_GROUPS) {
      if (group.includes(k)) {
        for (const form of group) out.add(form)
        break
      }
    }
  }
  return [...out]
}
