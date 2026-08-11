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
  // Provenance (v2): where a memory comes from, so every fact is auditable.
  createdBy?: "memory_write" | "memory_update" | "consolidation"
  sourceSessionID?: string
  sourceMessageIDs?: string[]
  extractedAt?: number
  confidence?: number
  // Tier (v2): core is always surfaced, archival only on relevance,
  // temporary expires, pinned never decays. Legacy entries are derived
  // from the category during migration (see normalizeStore).
  tier?: "core" | "archival" | "temporary"
  pinned?: boolean
  expiresAt?: number
  // Lifecycle (v2): explicit memories that the consolidation contradicts
  // are marked CONFLICTED (never silently overwritten); user resolution
  // brings them back to ACTIVE; replaced ones become SUPERSEDED tombstones.
  status?: "ACTIVE" | "CONFLICTED" | "SUPERSEDED"
  conflictEvidence?: string
  conflictAt?: number
  supersededAt?: number
  // Usage feedback (v2): how the memory performed in retrieval.
  useCount?: number
  lastUsed?: number
  helpfulCount?: number
  irrelevantCount?: number
  // Privacy (v2): local-only facts are never surfaced to remote providers
  // nor included in consolidation prompts.
  sensitivity?: "normal" | "private" | "local-only"
}

export type Store = {
  version: 2
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
  return { version: 2, summary: "", updatedAt: 0, entries: [] }
}

// Legacy stores (version 1) are migrated in place: unknown categories fall
// back to "other", and each entry gets its tier, status and sensitivity
// defaults derived from what v1 already encoded.
export function normalizeStore(store: Store): Store {
  const v = (store as { version?: unknown }).version
  if (v !== 1 && v !== 2) return emptyStore()
  store.version = 2
  for (const e of store.entries) {
    if (e.category === "general" || !CATEGORIES.includes(e.category)) e.category = "other"
    if (!e.tier) e.tier = CORE_CATEGORIES.has(e.category) ? "core" : "archival"
    if (!e.status) e.status = "ACTIVE"
    if (!e.sensitivity) e.sensitivity = "normal"
  }
  return store
}

// Time-based decay is applied HERE and nowhere else. weight is a static
// importance baseline (raised on refresh, never decayed in place): the score
// of an entry therefore depends only on how much time has passed, never on
// how many times prune() happened to run.
export function score(entry: Entry, t = Date.now()): number {
  if (entry.pinned === true) {
    const sourceBonusPinned = entry.source === "explicit" ? 0.5 : 0
    return entry.weight + sourceBonusPinned + utilizationBonus(entry)
  }
  const days = Math.max(0, (t - entry.lastSeen) / DAY)
  const sourceBonus = entry.source === "explicit" ? 0.5 : 0
  return (entry.weight + sourceBonus + utilizationBonus(entry)) * Math.exp(-days / 45)
}

// Usage feedback modulates the score: memories that proved helpful rank
// higher and are forgotten later; memories marked irrelevant rank lower.
// Both bonuses saturate to keep the scale bounded.
export function utilizationBonus(entry: Entry): number {
  const helpful = Math.min(5, entry.helpfulCount ?? 0) * 0.1
  const irrelevant = Math.min(5, entry.irrelevantCount ?? 0) * 0.15
  return Math.max(-0.5, helpful - irrelevant)
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
  // Never mutate weight here: decay is applied exclusively in score().
  // Entries below the floor are removed (their score is a function of time
  // alone, so removal is deterministic regardless of prune frequency).
  // SUPERSEDED tombstones are dropped after a short grace period so the
  // "forgot" history stays queryable for a while without accumulating.
  store.entries = store.entries.filter((e) => {
    if (e.status === "SUPERSEDED") {
      const supersededAt = e.supersededAt ?? e.lastSeen
      return t - supersededAt < 30 * DAY
    }
    if (e.expiresAt !== undefined && e.expiresAt <= t) return false
    return score(e, t) >= 0.15
  })
  store.entries.sort((a, b) => score(b, t) - score(a, t))
  store.entries = store.entries.slice(0, maxEntries)
}

export type LogLevel = "debug" | "info" | "warn" | "error"

export type ConsolidationSource = {
  sessionID?: string
  messageIDs?: string[]
}

export function applyConsolidation(
  store: Store,
  parsed: {
    new?: any[]
    update?: any[]
    delete?: string[]
    summary?: string
    conflicts?: { id?: string; evidence?: string }[]
  },
  projectID: string | undefined,
  t = Date.now(),
  log?: (level: LogLevel, message: string, extra?: Record<string, unknown>) => void,
  source?: ConsolidationSource,
) {
  for (const item of parsed.new ?? []) {
    if (!item || typeof item.text !== "string" || !item.text.trim()) continue
    const text = item.text.trim()
    const scope: Entry["scope"] = item.scope === "project" ? "project" : "global"
    const category = typeof item.category === "string" && CATEGORIES.includes(item.category) ? item.category : "other"
    const existing = findSimilar(store.entries, text, 0.5)
    const confidence =
      typeof item.confidence === "number" && item.confidence >= 0 && item.confidence <= 1 ? item.confidence : undefined
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
      existing.createdBy = "consolidation"
      existing.sourceSessionID = source?.sessionID ?? existing.sourceSessionID
      existing.extractedAt = t
      if (confidence !== undefined) existing.confidence = confidence
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
        createdBy: "consolidation",
        sourceSessionID: source?.sessionID,
        sourceMessageIDs: source?.messageIDs,
        extractedAt: t,
        confidence,
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
      target.extractedAt = t
      target.sourceSessionID = source?.sessionID ?? target.sourceSessionID
    }
  }
  for (const item of parsed.delete ?? []) {
    if (typeof item !== "string") continue
    const del = item.trim()
    const target = store.entries.find((e) => e.id === del)
    if (target && target.source !== "explicit") {
      // Dreamed entries are never hard-deleted by consolidation: they become
      // SUPERSEDED tombstones (auditable, pruned after the grace period).
      target.status = "SUPERSEDED"
      target.supersededAt = t
    } else {
      store.entries = store.entries.filter(
        (e) => e.source === "explicit" || (e.id !== del && !(del.length > 3 && e.text.toLowerCase().includes(del.toLowerCase()))),
      )
    }
  }
  // Contradiction reporting: an explicit entry the conversation conflicts
  // with is flagged, never silently overwritten. The user (or the agent on
  // their behalf) resolves it via memory_update / memory_write.
  for (const c of parsed.conflicts ?? []) {
    if (!c || typeof c.id !== "string") continue
    const target = store.entries.find((e) => e.id === c.id)
    if (!target) continue
    const evidence = typeof c.evidence === "string" ? c.evidence.slice(0, 500) : ""
    target.status = "CONFLICTED"
    target.conflictEvidence = evidence || "contradicted in a later conversation"
    target.conflictAt = t
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

// ---------------------------------------------------------------------------
// Retrieval pipeline
// ---------------------------------------------------------------------------

export const KEYWORD_BONUS = 3

export type RankedMemory = {
  entry: Entry
  // base: pure time/weight score, before any relevance bonus.
  base: number
  // keywordHits: how many expanded topic keywords matched the memory text.
  keywordHits: number
  // core: the memory was selected through its core tier slot, not relevance.
  core: boolean
  // rank: 1-based final position within the candidate window.
  rank: number
  // final: total ordering score (base + keyword bonus).
  final: number
}

export type RetrieveOptions = {
  // Excluded sensitivity levels: entries with these values are never
  // returned (surface excludes "local-only"; memory_read excludes none).
  excludeSensitivity?: Set<Entry["sensitivity"]>
  // Candidate window handed to the (optional) semantic reranker.
  candidateCount?: number
}

// Lexical stage of the hybrid pipeline: scope filter + expanded-keyword
// relevance + time/weight score. Returns the top candidate window, sorted,
// each item carrying the breakdown needed to explain WHY it ranked there.
export function retrieve(
  store: Store,
  directory: string | undefined,
  query: string,
  t = Date.now(),
  opts: RetrieveOptions = {},
): RankedMemory[] {
  const window = opts.candidateCount ?? 30
  const expanded = expandTopicKeywords(topicKeywords(query))
  const candidates = store.entries.filter(
    (e) =>
      e.status !== "SUPERSEDED" &&
      (e.expiresAt === undefined || e.expiresAt > t) &&
      (e.scope === "global" || (e.scope === "project" && e.projectID === directory)) &&
      !(opts.excludeSensitivity && e.sensitivity && opts.excludeSensitivity.has(e.sensitivity)),
  )
  const ranked = candidates.map((e) => {
    const et = norm(e.text)
    const hits = expanded.length === 0 ? 0 : expanded.filter((k) => et.includes(k) || e.category === k).length
    const base = score(e, t)
    return { entry: e, base, keywordHits: hits, core: false, rank: 0, final: base + hits * KEYWORD_BONUS }
  })
  ranked.sort((a, b) => b.final - a.final)
  const top = ranked.slice(0, window)
  top.forEach((r, i) => (r.rank = i + 1))
  return top
}

// Core-slot selection: core-tier memories that did NOT rank via relevance
// are injected anyway (operative preferences always available), newest first,
// up to maxCore. CONFLICTED entries are kept visible so they can be resolved.
export function coreSlot(store: Store, directory: string | undefined, exclude: Set<string>, t = Date.now(), maxCore = 3): Entry[] {
  return store.entries
    .filter(
      (e) =>
        e.status !== "SUPERSEDED" &&
        e.tier === "core" &&
        (e.expiresAt === undefined || e.expiresAt > t) &&
        (e.scope === "global" || (e.scope === "project" && e.projectID === directory)) &&
        e.sensitivity !== "local-only" &&
        !exclude.has(e.id),
    )
    .sort((a, b) => score(b, t) - score(a, t))
    .slice(0, maxCore)
}
