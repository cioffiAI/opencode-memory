// Benchmark scenarios: each case builds a synthetic store (or a subset of
// memories) and defines the expected retrieval result.
//
// ids map to store indexes m0..mN inside each scenario. expected: [] means
// nothing should surface. tags group scenarios by failure mode so the report
// can break Recall down per category.

const ST = "status"
const PREF = "preferences"
const PROJ = "project"

type Memory = {
  text: string
  category?: string
  scope?: "global" | "project"
  projectID?: string
  weight?: number
  lastSeenAgoDays?: number
  helpful?: number
  irrelevant?: number
}

type Scenario = {
  id: string
  tags: string[]
  memories: Memory[]
  query: string
  expected: number[]
  directory?: string
}

export const SCENARIOS: Scenario[] = [
  // ---- keyword: literal word matches --------------------------------
  { id: "kw-01", tags: ["keyword"], memories: [{ text: "The user prefers TypeScript over JavaScript.", category: PREF }], query: "which language does the user prefer?", expected: [0] },
  { id: "kw-02", tags: ["keyword"], memories: [{ text: "The user works on a MacBook Air M4.", category: ST }], query: "what laptop does the user use?", expected: [0] },
  { id: "kw-03", tags: ["keyword"], memories: [{ text: "The user prefers dark mode in the editor.", category: PREF }], query: "dark mode or light mode?", expected: [0] },
  { id: "kw-04", tags: ["keyword"], memories: [{ text: "The user uses Bun as the runtime.", category: ST }], query: "what runtime does the user use?", expected: [0] },
  { id: "kw-05", tags: ["keyword"], memories: [{ text: "The user writes documentation in English.", category: PREF }], query: "which language for docs?", expected: [0] },
  { id: "kw-06", tags: ["keyword"], memories: [{ text: "The user runs tests before every commit.", category: PREF }], query: "does the user run tests?", expected: [0] },
  { id: "kw-07", tags: ["keyword"], memories: [{ text: "The user prefers the arc browser.", category: PREF }], query: "which browser does the user prefer?", expected: [0] },
  { id: "kw-08", tags: ["keyword"], memories: [{ text: "The user codes in Rust for systems programming.", category: ST }], query: "what language for low-level code?", expected: [0] },
  { id: "kw-09", tags: ["keyword"], memories: [{ text: "The user prefers PostgreSQL over MySQL.", category: PREF }], query: "which database does the user prefer?", expected: [0] },
  { id: "kw-10", tags: ["keyword"], memories: [{ text: "The user uses Neovim as the editor.", category: ST }], query: "which editor does the user use?", expected: [0] },

  // ---- paraphrase: same meaning, different words ---------------------
  { id: "pa-01", tags: ["paraphrase"], memories: [{ text: "The user prefers green as their favorite color.", category: PREF }], query: "what is the user's favorite color?", expected: [0] },
  { id: "pa-02", tags: ["paraphrase"], memories: [{ text: "The user is a vegetarian.", category: ST }], query: "does the user eat meat?", expected: [0] },
  { id: "pa-03", tags: ["paraphrase"], memories: [{ text: "The user is allergic to shellfish.", category: ST }], query: "any food allergies to watch out for?", expected: [0] },
  { id: "pa-04", tags: ["paraphrase"], memories: [{ text: "The user sleeps seven hours per night.", category: ST }], query: "what is the user's nightly sleep duration?", expected: [0] },
  { id: "pa-05", tags: ["paraphrase"], memories: [{ text: "The user pays for the ChatGPT Pro plan.", category: ST }], query: "is the user a paying ChatGPT customer?", expected: [0] },
  { id: "pa-06", tags: ["paraphrase"], memories: [{ text: "The user trains for marathons on weekends.", category: ST }], query: "what does the user do on Saturdays for fitness?", expected: [0] },
  { id: "pa-07", tags: ["paraphrase"], memories: [{ text: "The user prefers monorepos to multi-repo setups.", category: PREF }], query: "one repository or several for projects?", expected: [0] },
  { id: "pa-08", tags: ["paraphrase"], memories: [{ text: "The user answers emails in the evening only.", category: PREF }], query: "when does the user reply to email?", expected: [0] },
  { id: "pa-09", tags: ["paraphrase"], memories: [{ text: "The user keeps a paper notebook for ideas.", category: ST }], query: "where does the user jot down brainstorm notes?", expected: [0] },
  { id: "pa-10", tags: ["paraphrase"], memories: [{ text: "The user bikes to the university campus.", category: ST }], query: "how does the user commute to uni?", expected: [0] },

  // ---- it-en / en-it cross-language --------------------------------------
  { id: "cross-01", tags: ["it-en"], memories: [{ text: "L'utente preferisce TypeScript per il frontend.", category: PREF }], query: "what does the user prefer for the frontend?", expected: [0] },
  { id: "cross-02", tags: ["it-en"], memories: [{ text: "L'utente lavora su un MacBook Air M4.", category: ST }], query: "what laptop does the user work on?", expected: [0] },
  { id: "cross-03", tags: ["it-en"], memories: [{ text: "L'utente usa il plugin opencode-memory.", category: ST }], query: "which plugin does the user use?", expected: [0] },
  { id: "cross-04", tags: ["it-en"], memories: [{ text: "L'utente preferisce scrivere documentazione in inglese.", category: PREF }], query: "which language does the user write docs in?", expected: [0] },
  { id: "cross-05", tags: ["it-en"], memories: [{ text: "L'utente odia le riunioni senza agenda.", category: PREF }], query: "how does the user feel about meetings?", expected: [0] },
  { id: "cross-06", tags: ["en-it"], memories: [{ text: "The user prefers Italian food.", category: PREF }], query: "che tipo di cucina preferisce l'utente?", expected: [0] },
  { id: "cross-07", tags: ["en-it"], memories: [{ text: "The user works from home on Fridays.", category: PREF }], query: "dove lavora l'utente il venerdi?", expected: [0] },
  { id: "cross-08", tags: ["en-it"], memories: [{ text: "The user is studying computer science.", category: ST }], query: "cosa sta studiando l'utente?", expected: [0] },
  { id: "cross-09", tags: ["en-it"], memories: [{ text: "The user prefers to deploy on Fridays.", category: PREF }], query: "quando preferisce fare deploy l'utente?", expected: [0] },
  { id: "cross-10", tags: ["it-en"], memories: [{ text: "L'utente vuole migrare a un'architettura serverless.", category: ST }], query: "is the user planning any migration?", expected: [0] },

  // ---- synonym: bilingual synonym groups ----------------------------------
  { id: "sy-01", tags: ["synonym"], memories: [{ text: "The user's favorite color is green.", category: PREF }], query: "quale colore piace all'utente?", expected: [0] },
  { id: "sy-02", tags: ["synonym"], memories: [{ text: "The user likes the rust color palette.", category: PREF }], query: "which color does the user prefer?", expected: [0] },
  { id: "sy-03", tags: ["synonym"], memories: [{ text: "The user deploys to their own server in the basement.", category: ST }], query: "where is the user hosting their app?", expected: [0] },
  { id: "sy-04", tags: ["synonym"], memories: [{ text: "The user runs tests before every commit.", category: PREF }], query: "does the user verify code before pushing?", expected: [0] },
  { id: "sy-05", tags: ["synonym"], memories: [{ text: "The user is fixing a networking issue with the router.", category: ST }], query: "quali problemi di rete ha l'utente?", expected: [0] },
  { id: "sy-06", tags: ["synonym"], memories: [{ text: "L'utente ha problemi con la sicurezza della sua app web.", category: ST }], query: "is the user dealing with any security issues?", expected: [0] },
  { id: "sy-07", tags: ["synonym"], memories: [{ text: "The user manages a small database of recipes.", category: ST }], query: "does the user manage any datasets?", expected: [0] },
  { id: "sy-08", tags: ["synonym"], memories: [{ text: "The user created a VS Code extension.", category: ST }], query: "quali estensioni ha creato l'utente?", expected: [0] },
  { id: "sy-09", tags: ["synonym"], memories: [{ text: "The user maintains a personal website.", category: ST }], query: "ha l'utente un sito personale?", expected: [0] },
  { id: "sy-10", tags: ["synonym"], memories: [{ text: "L'utente cerca un nuovo lavoro nel settore AI.", category: ST }], query: "is the user looking for a new job?", expected: [0] },

  // ---- distractors: noise must not win ------------------------------------
  { id: "di-01", tags: ["distractor"], memories: [
    { text: "The user prefers Rust for systems programming.", category: PREF },
    { text: "The user likes the color rust for their bike.", category: PREF },
    { text: "The user's bike is 8 years old.", category: ST },
  ], query: "which language for the low-level utility?", expected: [0] },
  { id: "di-02", tags: ["distractor"], memories: [
    { text: "The user uses Bun as the runtime.", category: ST },
    { text: "The user has a pet rabbit named Bun.", category: ST },
    { text: "The user bakes bread on Sundays.", category: ST },
  ], query: "what runtime does the user's project need?", expected: [0] },
  { id: "di-03", tags: ["distractor"], memories: [
    { text: "The user prefers the dark theme everywhere.", category: PREF },
    { text: "The user's room is painted dark green.", category: ST },
    { text: "The user prefers dark roast coffee.", category: PREF },
  ], query: "dark mode or light mode in the editor?", expected: [0] },
  { id: "di-04", tags: ["distractor"], memories: [
    { text: "The user maintains a memory plugin for opencode.", category: ST },
    { text: "The user has a good memory for birthdays.", category: ST },
    { text: "The user works on a project called memory-notes.", category: ST },
  ], query: "what does the plugin do?", expected: [0] },
  { id: "di-05", tags: ["distractor"], memories: [
    { text: "The user prefers git over mercurial.", category: PREF },
    { text: "The user is a git of many skills at work.", category: ST },
    { text: "The user dislikes rebasing.", category: PREF },
  ], query: "which version control tool does the user prefer?", expected: [0] },
  { id: "di-06", tags: ["distractor"], memories: [
    { text: "The user is learning Spanish.", category: ST },
    { text: "Spain is the user's favorite holiday destination.", category: ST },
    { text: "The user speaks Italian and English.", category: ST },
  ], query: "which languages does the user speak?", expected: [2] },
  { id: "di-07", tags: ["distractor"], memories: [
    { text: "The user likes the app store for Mac apps.", category: PREF },
    { text: "The user stores files on an external drive.", category: ST },
    { text: "The user manages a retail store on weekends.", category: ST },
  ], query: "how does the user install applications?", expected: [0] },
  { id: "di-08", tags: ["distractor"], memories: [
    { text: "The user prefers testing with bun test.", category: PREF },
    { text: "The user tested positive for strep throat.", category: ST },
    { text: "The user's car failed its emissions test.", category: ST },
  ], query: "what test framework does the user prefer?", expected: [0] },
  { id: "di-09", tags: ["distractor"], memories: [
    { text: "The user uses the AWS cloud for hosting.", category: ST },
    { text: "The user loves cloudy weather.", category: PREF },
    { text: "The user keeps files in a personal cloud drive.", category: ST },
  ], query: "where are the user's services deployed?", expected: [0] },
  { id: "di-10", tags: ["distractor"], memories: [
    { text: "The user is an expert in security testing.", category: ST },
    { text: "The user keeps home security cameras.", category: ST },
    { text: "The user's job is building secure systems.", category: ST },
  ], query: "what is the user's profession?", expected: [2] },

  // ---- contradiction: newer fact must win ---------------------------------
  { id: "co-01", tags: ["contradiction"], memories: [
    { text: "The user uses npm as the package manager.", category: PREF, weight: 3 },
    { text: "The user now uses Bun as the package manager.", category: PREF, weight: 3, lastSeenAgoDays: 2 },
  ], query: "which package manager does the user use?", expected: [1] },
  { id: "co-02", tags: ["contradiction"], memories: [
    { text: "The user drinks coffee in the morning.", category: PREF, weight: 3 },
    { text: "The user switched to tea entirely.", category: PREF, weight: 3, lastSeenAgoDays: 5 },
  ], query: "what does the user drink?", expected: [1] },
  { id: "co-03", tags: ["contradiction"], memories: [
    { text: "The user lives in Rome.", category: ST, weight: 3 },
    { text: "The user moved to Milan.", category: ST, weight: 3, lastSeenAgoDays: 1 },
  ], query: "where does the user live now?", expected: [1] },
  { id: "co-04", tags: ["contradiction"], memories: [
    { text: "The user works in banking.", category: ST, weight: 3 },
    { text: "The user works as a freelance developer.", category: ST, weight: 3, lastSeenAgoDays: 3 },
  ], query: "what does the user do for a living?", expected: [1] },
  { id: "co-05", tags: ["contradiction"], memories: [
    { text: "The user prefers vim.", category: PREF, weight: 3 },
    { text: "The user now prefers neovim.", category: PREF, weight: 3, lastSeenAgoDays: 4 },
  ], query: "which editor does the user use?", expected: [1] },

  // ---- duplicate: canonical entry wins ------------------------------------
  { id: "du-01", tags: ["duplicate"], memories: [
    { text: "The user prefers TypeScript over JavaScript.", category: PREF, weight: 3 },
    { text: "User likes TS more than JS.", category: PREF, weight: 1 },
  ], query: "typescript or javascript?", expected: [0] },
  { id: "du-02", tags: ["duplicate"], memories: [
    { text: "The user's favorite color is green.", category: PREF, weight: 3 },
    { text: "Green is the colour the user prefers.", category: PREF, weight: 1 },
  ], query: "what color does the user like?", expected: [0] },
  { id: "du-03", tags: ["duplicate"], memories: [
    { text: "The user uses bun for everything.", category: ST, weight: 3 },
    { text: "Everything the user writes runs on bun.", category: ST, weight: 1 },
  ], query: "what runtime does the user use?", expected: [0] },

  // ---- isolation: project scope must not leak ------------------------------
  { id: "is-01", tags: ["isolation"], memories: [
    { text: "This project uses Bun and TypeScript.", category: PROJ, scope: "project", projectID: "/workspace/plugin" },
    { text: "This project uses Flask and Python.", category: PROJ, scope: "project", projectID: "/workspace/api" },
    { text: "The user prefers typed languages.", category: PREF },
  ], query: "what stack does this project use?", expected: [0], directory: "/workspace/plugin" },
  { id: "is-02", tags: ["isolation"], memories: [
    { text: "The monorepo is organized with pnpm workspaces.", category: PROJ, scope: "project", projectID: "/apps" },
    { text: "The CLI repo is a single package with no workspaces.", category: PROJ, scope: "project", projectID: "/tools/cli" },
  ], query: "how are the workspaces organized here?", expected: [0], directory: "/apps" },
  { id: "is-03", tags: ["isolation"], memories: [
    { text: "The app is deployed on Vercel.", category: PROJ, scope: "project", projectID: "/web" },
    { text: "The API is deployed on Fly.io.", category: PROJ, scope: "project", projectID: "/backend" },
  ], query: "where is the frontend deployed?", expected: [0], directory: "/web" },
  { id: "is-04", tags: ["isolation"], memories: [
    { text: "The database is PostgreSQL via Docker.", category: PROJ, scope: "project", projectID: "/shop" },
    { text: "The database is SQLite, no containers.", category: PROJ, scope: "project", projectID: "/notes" },
  ], query: "which database does the project use?", expected: [0], directory: "/shop" },
  { id: "is-05", tags: ["isolation"], memories: [
    { text: "Coding style: tabs, 120 columns.", category: PROJ, scope: "project", projectID: "/a" },
    { text: "Coding style: spaces, 80 columns.", category: PROJ, scope: "project", projectID: "/b" },
  ], query: "what indentation style does this project use?", expected: [0], directory: "/a" },
  { id: "is-06", tags: ["isolation"], memories: [
    { text: "The user only browses /b from this laptop.", category: PROJ, scope: "project", projectID: "/x" },
  ], query: "does any project memory exist for /y?", expected: [], directory: "/y" },

  // ---- obsolete: stale memories rank low -----------------------------------
  { id: "ob-01", tags: ["obsolete"], memories: [
    { text: "The user's favorite phone was a Nokia 3310.", category: ST, lastSeenAgoDays: 900, weight: 0.5 },
    { text: "The user's current phone is a Pixel 9.", category: ST, lastSeenAgoDays: 1, weight: 2 },
  ], query: "what phone does the user have?", expected: [1] },
  { id: "ob-02", tags: ["obsolete"], memories: [
    { text: "The user commuted by bus to the old office.", category: ST, lastSeenAgoDays: 700, weight: 0.5 },
    { text: "The user bikes to the new office.", category: ST, lastSeenAgoDays: 2, weight: 2 },
  ], query: "how does the user get to work?", expected: [1] },
  { id: "ob-03", tags: ["obsolete"], memories: [
    { text: "The user studied physics in 2019.", category: ST, lastSeenAgoDays: 600, weight: 0.5 },
    { text: "The user studies computer science now.", category: ST, lastSeenAgoDays: 3, weight: 2 },
  ], query: "what is the user studying?", expected: [1] },
  { id: "ob-04", tags: ["obsolete"], memories: [
    { text: "The user's stack was PHP in 2020.", category: ST, lastSeenAgoDays: 800, weight: 0.5 },
    { text: "The user's stack is Rust and Bun.", category: ST, lastSeenAgoDays: 6, weight: 2 },
  ], query: "what is the user's stack today?", expected: [1] },
  { id: "ob-05", tags: ["obsolete"], memories: [
    { text: "The user was on Windows.", category: ST, lastSeenAgoDays: 500, weight: 0.5 },
    { text: "The user is on macOS now.", category: ST, lastSeenAgoDays: 10, weight: 2 },
  ], query: "which OS does the user use?", expected: [1] },

  // ---- false positive: shared words, different meaning ---------------------
  { id: "fp-01", tags: ["false-positive"], memories: [
    { text: "The user likes the color of the rust bike frame.", category: PREF },
  ], query: "which language did the user pick for the CLI?", expected: [] },
  { id: "fp-02", tags: ["false-positive"], memories: [
    { text: "The user keeps a test account for staging.", category: ST },
  ], query: "what test framework should I use here?", expected: [] },
  { id: "fp-03", tags: ["false-positive"], memories: [
    { text: "The memory plugin stores facts on disk.", category: ST },
  ], query: "how much RAM does the user's machine have?", expected: [] },
  { id: "fp-04", tags: ["false-positive"], memories: [
    { text: "The user prefers working with data pipelines.", category: PREF },
  ], query: "which database should we choose for the app?", expected: [] },
  { id: "fp-05", tags: ["false-positive"], memories: [
    { text: "The user's favorite coffee is from the green roastery.", category: PREF },
  ], query: "what color theme does the user prefer in the IDE?", expected: [] },

  // ---- none: nothing relevant ----------------------------------------------
  { id: "no-01", tags: ["none"], memories: [
    { text: "The user prefers Rust for systems programming.", category: PREF },
    { text: "The user likes green.", category: PREF },
  ], query: "has the user mentioned any trip plans?", expected: [] },
  { id: "no-02", tags: ["none"], memories: [
    { text: "The user works with PostgreSQL.", category: ST },
  ], query: "does the user own a dog?", expected: [] },
  { id: "no-03", tags: ["none"], memories: [
    { text: "The user studies computer science.", category: ST },
  ], query: "what is the user's favorite music?", expected: [] },
  { id: "no-04", tags: ["none"], memories: [
    { text: "The user prefers dark mode.", category: PREF },
  ], query: "where does the user go on holidays?", expected: [] },
  { id: "no-05", tags: ["none"], memories: [
    { text: "The user uses the arc browser.", category: PREF },
  ], query: "does the user have any pets?", expected: [] },
  { id: "no-06", tags: ["none"], memories: [
    { text: "The user's editor is Neovim.", category: PREF },
  ], query: "what is the user's shoe size?", expected: [] },
  { id: "no-07", tags: ["none"], memories: [
    { text: "The user writes in Italian.", category: ST },
  ], query: "has the user seen the new movie?", expected: [] },
  { id: "no-08", tags: ["none"], memories: [
    { text: "The user bikes to campus.", category: ST },
  ], query: "what is the user's favorite restaurant?", expected: [] },
  { id: "no-09", tags: ["none"], memories: [
    { text: "The user runs tests before every commit.", category: PREF },
  ], query: "does the user play chess?", expected: [] },
  { id: "no-10", tags: ["none"], memories: [
    { text: "The user keeps a paper notebook.", category: ST },
  ], query: "what car does the user drive?", expected: [] },

  // ---- usage feedback: helpful/irrelevant modulate ranking ----------------
  { id: "fb-01", tags: ["feedback"], memories: [
    { text: "The user prefers the arc browser.", category: PREF, helpful: 4 },
    { text: "The user's brother prefers chrome.", category: ST, irrelevant: 3 },
  ], query: "which browser does the user prefer?", expected: [0] },
  { id: "fb-02", tags: ["feedback"], memories: [
    { text: "The user likes plain text formats.", category: PREF, helpful: 2 },
    { text: "The user once tried markdown files.", category: ST },
  ], query: "does the user like markdown?", expected: [1] },

  // ---- core preferences always available -----------------------------------
  { id: "core-01", tags: ["keyword"], memories: [
    { text: "The user's favorite song is by a band called Coffee.", category: ST },
    { text: "The user prefers coffee over tea.", category: PREF },
  ], query: "what is the user's favorite song?", expected: [0] },

  // ---- multi-expected: two facts should both surface -----------------------
  { id: "me-01", tags: ["keyword"], memories: [
    { text: "The user prefers TypeScript.", category: PREF },
    { text: "The user prefers Bun.", category: PREF },
  ], query: "what's the user's preferred language and runtime?", expected: [0, 1] },
  { id: "me-02", tags: ["keyword"], memories: [
    { text: "The user's editor is Neovim.", category: PREF },
    { text: "The user's terminal is Ghostty.", category: PREF },
  ], query: "which editor and terminal does the user use?", expected: [0, 1] },
  { id: "me-03", tags: ["keyword"], memories: [
    { text: "The user deploys on Vercel.", category: ST },
    { text: "The user stores data in Postgres.", category: ST },
  ], query: "where does the user deploy and what database?", expected: [0, 1] },
]
