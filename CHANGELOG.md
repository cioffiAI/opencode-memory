# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.5.0] — 2026-08-11

### Added

- Time-based decay is now applied exactly once, in `score()`, computed from
  `lastSeen`: previously `prune()` decayed `weight` in place and `score()`
  decayed again, so forgetting depended on how often pruning ran rather than
  on elapsed time. `weight` is now a static importance baseline (never
  mutated); `prune()` only applies the floor to the score.
- Provenance: dreamed memories record `sourceSessionID`, `sourceMessageIDs`,
  `extractedAt` and `confidence`; explicit ones record `createdBy`. New
  `memory_why` tool explains where a memory comes from and why it ranks
  where it does.
- Memory Inspector: `memory_inspect` with `stats`, `recent`, `conflicts`,
  `project` and `surfaced` views, including the "why was this surfaced"
  breakdown (base score, keyword match, core bonus, final rank).
- Contradiction lifecycle: the consolidation reports conflicts against
  `explicit` entries (`conflicts` in DREAM output); entries become
  CONFLICTED instead of being silently overwritten, and `memory_update` /
  `memory_write` resolves them. Replaced dreamed entries become SUPERSEDED
  tombstones (grace-period pruned).
- Memory tiers: `core` (always surfaced), `archival` (on relevance),
  `temporary` (`expiresAt`, auto-removed), `pinned` (never decays). Legacy
  stores migrate their tiers from categories.
- Hybrid retrieval: pure `retrieve()` pipeline (scope filter + expanded
  keyword relevance + time score) with an optional semantic reranking stage
  (`OPENCODE_MEMORY_RERANK=1`) that reranks the candidate window through a
  headless LLM call (per-query cache, timeout fallback to lexical order).
  Surfacing is relevance-gated: off-topic queries surface nothing but the
  core slot.
- Retrieval feedback: `memory_useful` / `memory_irrelevant` update
  `useCount` / `lastUsed` / `helpfulCount` / `irrelevantCount`; the score
  integrates a bounded utilization bonus. Surfaced memories refresh
  `lastSeen` (debounced) so active memories stay alive by exposure.
- Per-memory privacy: `sensitivity` (`normal` | `private` | `local-only`);
  `local-only` facts are never surfaced to providers nor included in
  consolidation prompts.
- Evaluation suite: `bun run bench` — 90 scenarios (paraphrase, IT/EN,
  synonyms, distractors, contradictions, duplicates, project isolation,
  obsolete facts, false positives, none) measuring Recall@5, Precision@5,
  MRR, false-surface rate and context overhead per failure mode.
- Store schema v2 with automatic v1 → v2 migration on read.

### Changed

- DREAM prompt: contradictions are reported (task 4) instead of silently
  ignored; new facts may carry an optional 0–1 `confidence`.
- `memory_write` accepts `tier`, `ttlHours`, `pinned` and `sensitivity`;
  rewriting a CONFLICTED entry resolves it.
- Surfaced CONFLICTED entries are flagged in the memory block so the agent
  can offer to fix them.

## [1.1.0] — 2026-08-06

### Added

- Cross-language semantic deduplication: second-pass LLM check inside the
  headless consolidation session plus code-level guards (`findSimilar`,
  `topicClash`).
- Source hierarchy: `explicit` (user-stated) memories always win over
  `dreamed` (inferred) ones; conflicting facts never enter the summary.
- Selective topic-aware SURFACE: topic keywords extracted from the last user
  message, expanded with bilingual synonyms (EN/IT), permanent core of
  operative categories always included.
- Orphan child-session garbage collection (age + inactivity, cross-process
  exempt via `inProgress` markers).
- Two-phase state commit (`inProgress` marker + `lastCompletedTs`): at-least-
  once consolidation semantics without duplicates, crash recovery included.
- Guard against consolidating a session while the assistant response is still
  streaming (prevents double consolidation).

### Changed

- Unified weight specification: 3 (explicit) / 1 (dreamed) on creation,
  +0.5 per confirmation, cap 4 for all sources.
- Single category list (`user`, `project`, `workflow`, `preferences`,
  `decisions`, `status`, `environment`, `other`); legacy `general` entries are
  migrated to `other` on read.
- Store reads are always fresh from disk (no stale in-memory cache).

### Fixed

- Silent consolidation skip caused by a non-existent `info.time.updated` field
  (real fields: `info.time.completed` / `info.time.created`).
- `waitForReply` reading the first turn's answer on a second LLM turn (now
  filters by timestamp).
- Double consolidation triggered by the sweep while the response was still
  streaming.

## [1.0.0] — 2026-08-05

### Added

- Initial release candidate: WRITE tools, headless DREAM consolidation,
  SURFACE memory injection, local JSON storage with file locking.
