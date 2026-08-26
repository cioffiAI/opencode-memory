// HELD-OUT evaluation set for v1.6 — DO NOT tune retrieval against these.
//
// Written BEFORE the v1.6 matcher/synonym changes were implemented, from the
// feature contract alone ("do not surface memories that do not answer the
// question"), without inspecting intermediate results while tuning.
// Scenarios marked CEILING-MEASURE are known-hard for any lexical system:
// they quantify the honest ceiling rather than assert achievability.
//
// Categories: substring-trap, identifier, package-name, path, false-friend,
// same-vocab-intent, related-tech, isolation, no-match, distractor,
// superseded, conflicted, cross-language positive/negative, core-only,
// project-isolation positive control.

import type { Scenario } from "./scenarios.ts"

const PREF = "preferences"
const ST = "status"
const PROJ = "project"

export const HELDOUT_SCENARIOS: Scenario[] = [
  // ---- substring traps -----------------------------------------------------
  { id: "hx-01", tags: ["heldout", "substring-trap"], memories: [
    { text: "The CI pipeline runs pytest with coverage reports.", category: ST },
  ], query: "add a test for the checkout flow", expected: [] },
  { id: "hx-02", tags: ["heldout", "substring-trap"], memories: [
    { text: "The user's greatest hits playlist has 100 songs.", category: ST },
  ], query: "write integration tests for payments", expected: [] },
  { id: "hx-03", tags: ["heldout", "identifier"], memories: [
    { text: "Session state lives in the userStore module.", category: PROJ },
  ], query: "where does userStore keep session state?", expected: [0] },
  { id: "hx-04", tags: ["heldout", "package-name"], memories: [
    { text: "The user hosts a mastodon instance for friends.", category: ST },
  ], query: "set up a node daemon with systemd units", expected: [] },
  { id: "hx-05", tags: ["heldout", "path"], memories: [
    { text: "The config template lives at src/utils/config.template.ts.", category: PROJ },
  ], query: "rotate the database credentials for production", expected: [] },
  { id: "hx-17", tags: ["heldout", "substring-trap"], memories: [
    { text: "The user's car is red.", category: ST },
  ], query: "redesign the report layout", expected: [] },
  { id: "hx-08", tags: ["heldout", "identifier"], memories: [
    { text: "The contest-results page is regenerated weekly.", category: PROJ },
  ], query: "pick a javascript test runner for the repo", expected: [] },

  // ---- same vocabulary, different intent ------------------------------------
  { id: "hx-06", tags: ["heldout", "same-vocab-intent"], memories: [
    { text: "The user prefers the fish shell on Linux.", category: PREF },
  ], query: "export SHELL=/bin/bash in the docker image", expected: [] },
  { id: "hx-19", tags: ["heldout", "same-vocab-intent"], memories: [
    { text: "The user works with RAM-heavy ML models.", category: ST },
  ], query: "buy more RAM for the build server", expected: [] }, // CEILING-MEASURE

  // ---- related technology, wrong fact ----------------------------------------
  { id: "hx-07", tags: ["heldout", "related-tech"], memories: [
    { text: "The user's API runs on PostgreSQL 14.", category: ST },
  ], query: "migrate the redis cache to the new cluster", expected: [] },

  // ---- semantically adjacent distractors (CEILING-MEASURE) -------------------
  { id: "hx-13", tags: ["heldout", "semantic-distractor"], memories: [
    { text: "The user's dentist recommended less coffee.", category: ST },
  ], query: "brew coffee for the office machine", expected: [] },
  { id: "hx-14", tags: ["heldout", "semantic-distractor"], memories: [
    { text: "The user's landlord handles building maintenance.", category: ST },
  ], query: "set up a repo maintenance cron job", expected: [] },

  // ---- lifecycle: superseded / conflicted ------------------------------------
  { id: "hx-09", tags: ["heldout", "superseded"], memories: [
    { text: "The user switched to the Ghostty terminal.", category: PREF, weight: 3, lastSeenAgoDays: 2 },
    { text: "The user prefers iTerm2 as terminal.", category: PREF, weight: 3, status: "SUPERSEDED" },
  ], query: "which terminal emulator does the user use?", expected: [0] },
  { id: "hx-10", tags: ["heldout", "conflicted"], memories: [
    { text: "The user now commits with jj.", category: PREF, weight: 3, lastSeenAgoDays: 1 },
    { text: "The user always commits with fossil.", category: PREF, weight: 3, status: "CONFLICTED", lastSeenAgoDays: 40 },
  ], query: "which VCS does the user commit with?", expected: [0] },

  // ---- isolation --------------------------------------------------------------
  { id: "hx-11", tags: ["heldout", "isolation-negative"], memories: [
    { text: "This service queues jobs through rabbitmq.", category: PROJ, scope: "project", projectID: "/jobs-svc" },
  ], query: "which message queue does this service use?", expected: [], directory: "/billing-api" },
  { id: "hx-20", tags: ["heldout", "isolation"], memories: [
    { text: "Billing API uses stripe webhooks.", category: PROJ, scope: "project", projectID: "/billing-api" },
  ], query: "how do payment callbacks arrive in this project?", expected: [0], directory: "/billing-api" },

  // ---- no-match ----------------------------------------------------------------
  { id: "hx-12", tags: ["heldout", "none"], memories: [
    { text: "The user writes Rust parsers for fun.", category: ST },
    { text: "The user prefers standing desks.", category: PREF },
  ], query: "recommend a quiet hotel in Lisbon for the offsite", expected: [] },

  // ---- cross-language ------------------------------------------------------------
  { id: "hx-15", tags: ["heldout", "en-it"], memories: [
    { text: "The user studies web security at university.", category: ST },
  ], query: "quali argomenti di sicurezza studia l'utente?", expected: [0] },
  { id: "hx-16", tags: ["heldout", "xl-negative"], memories: [
    { text: "The user enjoys cooking pasta on Sundays.", category: ST },
  ], query: "il server di produzione e giu, indagare subito", expected: [] },

  // ---- core-only -----------------------------------------------------------------
  { id: "hx-18", tags: ["heldout", "core-only"], memories: [
    { text: "The user prefers dark themes everywhere.", category: PREF },
  ], query: "extract the archive into /var/lib/app and chown it", expected: [] },
]
