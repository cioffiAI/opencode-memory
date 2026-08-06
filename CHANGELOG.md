# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
