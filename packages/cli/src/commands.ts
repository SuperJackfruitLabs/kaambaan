/**
 * Every command `supi` has, stated once.
 *
 * Three things read this table, and that is the reason it exists:
 *
 *   - `supi help` (the USAGE block) and `supi help <verb>` / `supi <verb> --help`,
 *   - the published reference at docs.superpipeline.dev/reference/cli/, generated from it by
 *     `reference.ts` and committed under `docs-site/src/content/docs/reference/cli/`,
 *   - `reference.test.ts`, which reads `index.ts` and fails when a verb, a sub-verb or a flag the
 *     switch handles has no entry here — or an entry here names something the switch never reads.
 *
 * Before this, the help text was a hand-written block beside the switch and the docs page was a
 * third copy, and the three disagreed: `set-stage --gate`, `--wip`, `--owner` and
 * `--clear-instructions` were dispatched and in neither the help nor the docs.
 *
 * The access column is a claim about the SERVER, not something this CLI enforces — `supi` adds no
 * authority and performs no permission check. `packages/docs-check` holds the agent-scope claims
 * against `apps/api`'s own `requiredScope`, so a server-side change that moves a route to another
 * scope fails CI here rather than leaving the reference wrong.
 */

export type FlagType = "boolean" | "string" | "integer" | "number" | "date" | "path" | "enum" | "list";

export interface FlagSpec {
  /** Including the leading dashes: `--comment`. */
  name: string;
  /** What the value is called in a synopsis (`<file|->`, `YYYY-MM-DD`). Absent for a boolean. */
  value?: string;
  type: FlagType;
  /** For `enum`. */
  choices?: string[];
  required?: boolean;
  repeatable?: boolean;
  /** What happens when the flag is left out, in words. */
  default?: string;
  description: string;
}

export interface ArgSpec {
  name: string;
  description: string;
  optional?: boolean;
  /** Takes every remaining positional, so a sentence needs no quoting. */
  rest?: boolean;
}

/** A workspace role, lowest first: each includes the ones before it. */
export type Role = "viewer" | "member" | "admin" | "owner";
export type Scope = "read" | "queue" | "plan" | "compose" | "claim" | "run";

export interface Access {
  /** The lowest workspace role that may do this, or `null` for a command that never reaches the server. */
  role: Role | null;
  /**
   * What an AGENT credential (`SUPERPIPELINE_AGENT_TOKEN[_FILE]`) needs:
   *   - a scope name: that scope, on an `spa_` token or an agent JWT,
   *   - `"any"`: any agent token, no scope checked,
   *   - `"refused"`: an agent may never do this, whatever it holds,
   *   - `null`: the command is local and sends nothing.
   */
  agent: Scope | "any" | "refused" | null;
  /** Anything the role and scope do not say. */
  note?: string;
}

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** With `:name` placeholders, as the server routes it. */
  path: string;
}

export interface CommandSpec {
  /** `["link", "add"]` for `supi link add`. */
  path: string[];
  group: GroupId;
  args: ArgSpec[];
  flags: FlagSpec[];
  /** One line, for the USAGE block. */
  summary: string;
  /** Paragraphs, for `supi help <verb>` and the reference. */
  description: string;
  /** The HTTP calls this makes, in order. Empty for a local command. */
  routes: Route[];
  access: Access;
  /** What it prints on success. */
  output: string;
  /** Each condition that makes it exit 1, beyond the ones every networked command shares. */
  fails: string[];
  examples: string[];
  /** Spelled differently in the synopsis than `args` + `flags` would render it. */
  synopsis?: string;
}

export type GroupId = "session" | "boards" | "cards" | "gates" | "links" | "labels" | "projects" | "schedules" | "workspace";

export interface GroupSpec {
  id: GroupId;
  title: string;
  /** Sidebar label and page heading. */
  label: string;
  description: string;
  intro: string;
}

export const GROUPS: GroupSpec[] = [
  {
    id: "session",
    title: "Signing in and the binary",
    label: "Session and setup",
    description: "supi login, logout, whoami, help, version and update.",
    intro:
      "Signing in, seeing which identity is in force, and keeping the binary current. `help`, `version`, " +
      "`update` and `logout` never send a credential anywhere.",
  },
  {
    id: "boards",
    title: "Boards and pipelines",
    label: "Boards and stages",
    description: "supi boards, board, templates, create-board, set-stages and set-stage.",
    intro:
      "Reading a board, and shaping its pipeline. Prefer `set-stage` over `set-stages`: it changes one stage " +
      "and leaves the others — and anybody else's concurrent edit to them — alone.",
  },
  {
    id: "cards",
    title: "Cards",
    label: "Cards",
    description: "supi card, create-card, move, archive and log.",
    intro: "Reading one card, queueing new work, moving it between stages, and reading what an agent did on it.",
  },
  {
    id: "gates",
    title: "Approval gates",
    label: "Gates",
    description: "supi gates, approve, reject and request-changes.",
    intro:
      "What is waiting on a human, and deciding it. Deciding a gate is the human half of the control pair: " +
      "an agent credential is refused on every decision verb, whatever scopes it carries.",
  },
  {
    id: "links",
    title: "Links between cards",
    label: "Links",
    description: "supi link add, link rm and link list.",
    intro:
      "Edges between cards: `blocks`, `relates` and `parent`. A same-board `blocks` edge is enforced — the " +
      "blocked card cannot be claimed. An edge to a card on another board is advisory: shown, never enforced.",
  },
  {
    id: "labels",
    title: "Labels",
    label: "Labels",
    description: "supi label list, label add and label rm.",
    intro: "The workspace's label catalogue — the one a card's labels are resolved against.",
  },
  {
    id: "projects",
    title: "Projects and milestones",
    label: "Projects and milestones",
    description: "supi project list, add, show and rm; supi milestone add and rm.",
    intro: "A project groups cards across boards; a milestone is an ordered step inside one project.",
  },
  {
    id: "schedules",
    title: "Recurring cards",
    label: "Schedules",
    description: "supi schedule list, add, rm, pause and resume.",
    intro:
      "A schedule creates a card on a cadence. Schedules are checked every five minutes, so a card may appear " +
      "up to five minutes after its stated time.",
  },
  {
    id: "workspace",
    title: "Workspace, agents and capabilities",
    label: "Workspace and agents",
    description: "supi forge, agents, agent queueing, capabilities and implications.",
    intro:
      "The two sides of routing — what a stage asks for and what an agent declares — and the workspace settings " +
      "beside them. Routing is exact string equality between a stage's `owner` and an agent's effective " +
      "capability set, so when a card will not move these are the whole diagnosis.",
  },
];

const BOARD: ArgSpec = { name: "boardId", description: "the board, as `brd_…` (see `supi boards`)" };
const CARD: ArgSpec = { name: "cardId", description: "the card, as `crd_…` (see `supi board <boardId>`)" };
const GATE: ArgSpec = { name: "gateId", description: "the gate (see `supi gates <boardId>`)" };
const SCHEDULE: ArgSpec = { name: "scheduleId", description: "the schedule (see `supi schedule list <boardId>`)" };

const COMMENT: FlagSpec = {
  name: "--comment",
  value: '"why"',
  type: "string",
  default: "no comment",
  description: "recorded with the decision and shown to whoever reads the card",
};

const LINK_KIND: FlagSpec = {
  name: "--kind",
  value: "blocks|relates|parent",
  type: "enum",
  choices: ["blocks", "relates", "parent"],
  required: true,
  description:
    "`blocks`: the from-card blocks the to-card (enforced on the same board); `relates`: an informational " +
    "edge; `parent`: the from-card contains the to-card as a sub-task",
};

const TO_BOARD: FlagSpec = {
  name: "--to-board",
  value: "<boardId>",
  type: "string",
  default: "the same board as `<boardId>`",
  description:
    "the board the to-card is on. Naming another board makes the edge advisory — stored and shown, never " +
    "enforced — and `link add` prints a notice saying so before it sends anything",
};

const DATE_FORMAT = "must be a date in `YYYY-MM-DD` form (checked before anything is sent)";

export const COMMANDS: CommandSpec[] = [
  // ── session ──────────────────────────────────────────────────────────────────────────────────
  {
    path: ["login"],
    group: "session",
    args: [],
    flags: [],
    summary: "sign in to this server's organization plane (device flow)",
    description:
      "Signs a person in from a terminal. `supi login` reads `$SUPERPIPELINE_URL/.well-known/oauth-protected-resource` " +
      "to find the server's sign-in service and audience — for app.superpipeline.dev that is " +
      "https://accounts.superjackfruit.com — and runs that service's device flow as the client `supi`: it prints a " +
      "link and a code, you open the link and confirm the code in a browser, and `supi` stores the long-lived " +
      "device credential it is given.\n\n" +
      "Every later command exchanges that device credential at the sign-in service's `/api/token/device` for a " +
      "short-lived token for this server's audience, and caches the token beside it. No browser is needed again " +
      "until the device credential is revoked or expires. The device credential is only ever sent to the sign-in " +
      "service recorded at login, over HTTPS (plain HTTP only for a loopback development server), with redirects " +
      "disabled.\n\n" +
      "Both files live in `superpipeline/` under the platform config directory and are written atomically with " +
      "mode 0600. Signing in again replaces them.",
    routes: [{ method: "GET", path: "/.well-known/oauth-protected-resource" }],
    access: { role: null, agent: null, note: "Anyone may start a sign-in; what you may then do is your role in the workspace." },
    output: "the link and code to confirm, then `Signed in.`",
    fails: [
      "the server does not name a separate sign-in service (it is not on the organization plane): `… does not sign in through an organization plane yet`",
      "the sign-in service will not start a device sign-in, or answers with something unexpected",
      "the sign-in is declined in the browser, or the code expires before it is confirmed",
      "the first token exchange is refused (device revoked, expired or suspended) or the service cannot be reached",
    ],
    examples: ["supi login", "SUPERPIPELINE_URL=http://localhost:8787 supi login"],
  },
  {
    path: ["logout"],
    group: "session",
    args: [],
    flags: [],
    summary: "forget that sign-in on this machine",
    description:
      "Deletes `supi login`'s device credential and token cache from this machine. It does not revoke the device " +
      "at the sign-in service and does not touch any other client's files or any environment variable — a " +
      "`SUPERPIPELINE_TOKEN` still in your shell is still used.",
    routes: [],
    access: { role: null, agent: null },
    output: "`Signed out on this machine.`",
    fails: [],
    examples: ["supi logout"],
  },
  {
    path: ["whoami"],
    group: "session",
    args: [],
    flags: [],
    summary: "who the stored token says you are",
    description:
      "Resolves the credential exactly as every other command would and prints what it says about itself: the " +
      "principal, its kind (`human` or `agent`), the server, where the credential came from, and when it expires. " +
      "It reads the token's claims without verifying them and makes no call to superpipeline, so a `whoami` that " +
      "looks right does not prove the server will accept the token — `supi boards` does. Resolving may exchange a " +
      "stored device credential for a fresh token, which is a call to the sign-in service.\n\n" +
      "An `spa_` agent token is opaque and carries no principal; `whoami` says so rather than failing.",
    routes: [],
    access: { role: null, agent: "any", note: "Needs a credential, but sends it only to the sign-in service, never to superpipeline." },
    output: "`principal`, `kind`, `superpipeline`, `token from`, `expires`; with `--json`, an object with the same fields",
    fails: ["no credential is found, or the one found has expired", "a human credential that is not a readable token"],
    examples: ["supi whoami", "supi whoami --json"],
  },
  {
    path: ["help"],
    group: "session",
    args: [{ name: "verb", description: "a command, with its sub-verb if it has one (`help link add`)", optional: true, rest: true }],
    flags: [],
    synopsis: "supi help [<verb> [<sub-verb>]]",
    summary: "this summary, or one command in full (also `supi <verb> --help`)",
    description:
      "With no argument, the summary of every command. With a verb, that command's synopsis, flags, access and " +
      "examples — the same text the reference pages are generated from. `supi <verb> --help` and " +
      "`supi <verb> <sub-verb> --help` print the same thing without running the command. `-h` and `--help` alone " +
      "are the summary.",
    routes: [],
    access: { role: null, agent: null },
    output: "help text",
    fails: ["the named verb does not exist"],
    examples: ["supi help", "supi help schedule add", "supi set-stage --help"],
  },
  {
    path: ["version"],
    group: "session",
    args: [],
    flags: [],
    summary: "print this binary's version",
    description:
      "Prints the release this binary was built as, and its platform. A binary run from a source checkout, rather " +
      "than a release, reports `dev`.",
    routes: [],
    access: { role: null, agent: null },
    output: "`supi <version> <platform>/<arch>`",
    fails: [],
    examples: ["supi version"],
  },
  {
    path: ["update"],
    group: "session",
    args: [],
    flags: [
      {
        name: "--check",
        type: "boolean",
        default: "off: install the newer release",
        description: "only say whether a newer release exists; install nothing",
      },
    ],
    summary: "replace this binary with the newest release",
    description:
      "Resolves the latest release tag on GitHub, downloads the asset for this platform (`supi-<platform>-<arch>`; " +
      "macOS and Linux only), verifies it against the release's `SHA256SUMS`, and renames it over the running " +
      "binary — staged in the binary's own directory so the swap is atomic. A download that cannot be verified is " +
      "refused rather than installed. A `dev` build is always offered the update. No credential is involved.",
    routes: [],
    access: { role: null, agent: null, note: "Talks to github.com only. Needs write access to the binary's directory, never sudo." },
    output: "`supi <version> is current …`, `supi <tag> is available …` (with `--check`), or `supi updated to <tag>.`",
    fails: [
      "the latest release cannot be read, or carries no tag",
      "no release binary is published for this platform",
      "the release has no `SHA256SUMS`, no digest for this asset, or the download fails its checksum",
    ],
    examples: ["supi update --check", "supi update"],
  },

  // ── boards ───────────────────────────────────────────────────────────────────────────────────
  {
    path: ["boards"],
    group: "boards",
    args: [],
    flags: [],
    summary: "the workspace's boards",
    description: "Every board in the workspace the credential belongs to, with its id.",
    routes: [{ method: "GET", path: "/v1/boards" }],
    access: { role: "viewer", agent: "read" },
    output: "one board per line; `--json` for the server's `{ boards: [...] }`",
    fails: [],
    examples: ["supi boards", "supi boards --json"],
  },
  {
    path: ["board"],
    group: "boards",
    args: [BOARD],
    flags: [],
    summary: "one board: its stages and their cards",
    description:
      "One board: each stage in order with its owner, gate and limits, and the cards standing in it. " +
      "`supi board <boardId> --json` prints the snapshot in the shape `create-board --stages` and `set-stages` " +
      "accept, so a pipeline can be read, edited and put back.",
    routes: [{ method: "GET", path: "/v1/boards/:boardId" }],
    access: { role: "viewer", agent: "read" },
    output: "stages with their cards; `--json` for the board snapshot",
    fails: ["`<boardId>` is missing"],
    examples: ["supi board brd_8f2c…", "supi board brd_8f2c… --json > pipeline.json"],
  },
  {
    path: ["templates"],
    group: "boards",
    args: [],
    flags: [],
    summary: "the starting pipelines --template accepts",
    description:
      "The board templates shipped with this binary: id, name, description and stage keys. Needs no credential — " +
      "they are part of the CLI, not fetched.",
    routes: [],
    access: { role: null, agent: null },
    output: "JSON: `[{ id, name, description, stages }]`",
    fails: [],
    examples: ["supi templates"],
  },
  {
    path: ["create-board"],
    group: "boards",
    args: [{ name: "name", description: "the board's name" }],
    flags: [
      {
        name: "--template",
        value: "<id>",
        type: "string",
        default: "`simple`",
        description: "start from a shipped template (see `supi templates`)",
      },
      {
        name: "--stages",
        value: "<file|->",
        type: "path",
        default: "the template's stages",
        description:
          "read the pipeline from a JSON file, or stdin for `-`: a non-empty array of stages, or an object with a " +
          "`stages` array (which is what `supi board <boardId> --json` prints). Every stage needs a string `key`",
      },
    ],
    summary: "create a board; --template defaults to `simple`",
    description:
      "Creates a board from a template or from a pipeline you supply. `--template` and `--stages` both name the " +
      "pipeline, so pass at most one. The board checks the stages itself; this only refuses a file that is the " +
      "wrong kind of thing.",
    routes: [{ method: "POST", path: "/v1/boards" }],
    access: { role: "admin", agent: "compose" },
    output: "JSON: the created board",
    fails: [
      "`<name>` is missing, or both `--template` and `--stages` are given",
      "no template has that id",
      "the stages file cannot be read, is not JSON, or is not a non-empty array of stages each with a `key`",
    ],
    examples: [
      "supi create-board 'Releases' --template software",
      "supi board brd_8f2c… --json | supi create-board 'Copy of releases' --stages -",
    ],
  },
  {
    path: ["set-stages"],
    group: "boards",
    args: [BOARD, { name: "file|-", description: "the new pipeline: a JSON file, or `-` for stdin, in the same shape `create-board --stages` takes" }],
    flags: [],
    summary: "replace a board's pipeline",
    description:
      "Replaces every stage of a board. Anything the file does not carry — another stage's instructions, a " +
      "completion rule, a concurrent edit — is discarded. To change one stage, use `set-stage`.",
    routes: [{ method: "PUT", path: "/v1/boards/:boardId/stages" }],
    access: { role: "admin", agent: "refused" },
    output: "JSON: the board's new stages",
    fails: ["`<boardId>` or the file is missing", "the file cannot be read, is not JSON, or is not a non-empty array of stages each with a `key`"],
    examples: ["supi board brd_8f2c… --json > p.json && $EDITOR p.json && supi set-stages brd_8f2c… p.json"],
  },
  {
    path: ["set-stage"],
    group: "boards",
    args: [BOARD, { name: "stageKey", description: "the stage's `key` (see `supi board <boardId>`)" }],
    flags: [
      {
        name: "--instructions",
        value: "<file|->",
        type: "path",
        default: "unchanged",
        description:
          "the stage's runbook — prose handed to whoever claims a card here — read from a file, or stdin for `-`. " +
          "A file rather than a string because shell quoting mangles paragraphs",
      },
      { name: "--clear-instructions", type: "boolean", default: "off", description: "remove the stage's instructions" },
      { name: "--name", value: "<name>", type: "string", default: "unchanged", description: "rename the stage" },
      {
        name: "--gate",
        value: "none|approval",
        type: "enum",
        choices: ["none", "approval"],
        default: "unchanged",
        description: "`approval` makes a card wait for a human decision before it leaves the stage",
      },
      {
        name: "--wip",
        value: "<n>|none",
        type: "integer",
        default: "unchanged",
        description: "the most cards the stage may hold at once; `none` removes the limit",
      },
      {
        name: "--owner",
        value: "<capability>",
        type: "string",
        default: "unchanged",
        description: "the capability an agent must hold to claim cards here",
      },
      {
        name: "--completion",
        value: "<file|->",
        type: "path",
        default: "unchanged",
        description:
          "what a run must produce before the board believes it finished, as JSON from a file or stdin " +
          "(see Stage runbooks and completion)",
      },
      { name: "--clear-completion", type: "boolean", default: "off", description: "remove the stage's completion requirement" },
    ],
    summary: "change ONE stage, leaving the others alone",
    description:
      "Changes the named fields of one stage and nothing else. At least one flag is required. A person may set any " +
      "field. An agent token with `compose` may set `--instructions` only — the other fields are routing, and the " +
      "server refuses them by name.",
    routes: [{ method: "PATCH", path: "/v1/boards/:boardId/stages/:stageKey" }],
    access: { role: "member", agent: "compose", note: "An agent may only send `--instructions`." },
    output: "JSON: the updated stage",
    fails: [
      "`<boardId>` or `<stageKey>` is missing, or no flag is given (`Nothing to change.`)",
      "an `--instructions` or `--completion` file cannot be read, or the completion file is not JSON",
    ],
    examples: [
      "supi set-stage brd_8f2c… build --instructions runbooks/build.md",
      "supi set-stage brd_8f2c… review --gate approval --wip 3",
      "supi set-stage brd_8f2c… build --clear-completion",
    ],
  },

  // ── cards ────────────────────────────────────────────────────────────────────────────────────
  {
    path: ["card"],
    group: "cards",
    args: [BOARD, CARD],
    flags: [],
    summary: "one card in full",
    description: "One card: its fields, stage, labels, references and state.",
    routes: [{ method: "GET", path: "/v1/boards/:boardId/cards/:cardId" }],
    access: { role: "viewer", agent: "read" },
    output: "JSON: the card",
    fails: ["`<boardId>` or `<cardId>` is missing"],
    examples: ["supi card brd_8f2c… crd_41aa…"],
  },
  {
    path: ["create-card"],
    group: "cards",
    args: [BOARD, { name: "title", description: "the card's title; every remaining word is part of it, so it needs no quoting", rest: true }],
    flags: [
      {
        name: "--spec",
        value: "<file|->",
        type: "path",
        default: "no spec",
        description: "the card's structured spec, as JSON from a file or stdin",
      },
      { name: "--priority", value: "<n>", type: "number", default: "`0`", description: "the card's priority" },
      { name: "--due", value: "YYYY-MM-DD", type: "date", default: "no due date", description: `the due date; ${DATE_FORMAT}` },
      {
        name: "--label",
        value: "<id>",
        type: "string",
        repeatable: true,
        default: "no labels",
        description: "a label id from `supi label list`; repeat for more than one. Applied by a second request after the card exists",
      },
    ],
    summary: "queue a card, with this token as its grant",
    description:
      "Creates a card in the board's first stage. The card records the credential that queued it as its grant — " +
      "who asked for the work and on whose authority. An agent's card is also bounded by the queueing policy " +
      "`supi agent queueing` sets: which boards may receive it, whose work it is, and how many cards an hour.",
    routes: [
      { method: "POST", path: "/v1/boards/:boardId/cards" },
      { method: "PATCH", path: "/v1/boards/:boardId/cards/:cardId" },
    ],
    access: {
      role: "member",
      agent: "queue",
      note: "The PATCH that applies `--label` also needs `plan` on an agent token. An agent's card is bounded by its queueing policy and dispatch grant.",
    },
    output: "JSON: the created card (or, with `--label`, the card after its labels are applied)",
    fails: [
      "`<boardId>` or `<title>` is missing",
      "`--spec` cannot be read or is not JSON",
      "`--due` is not `YYYY-MM-DD`",
    ],
    examples: [
      "supi create-card brd_8f2c… Write the release notes for 0.0.9",
      "supi create-card brd_8f2c… Audit the token routes --spec spec.json --priority 2 --due 2026-11-01 --label lbl_sec",
    ],
  },
  {
    path: ["move"],
    group: "cards",
    args: [BOARD, CARD, { name: "stageKey", description: "the stage to move it to" }],
    flags: [],
    summary: "move a card to another stage",
    description:
      "Moves a card to another stage. Moving a card into a stage an agent works is a dispatch, so the mover is " +
      "recorded as the one who queued it — and an agent mover passes the same queueing checks a create does.",
    routes: [{ method: "POST", path: "/v1/boards/:boardId/cards/:cardId/move" }],
    access: { role: "member", agent: "plan", note: "An agent moving a card into an agent-owned stage also needs a dispatch grant and a queueing policy that permits it." },
    output: "JSON: the moved card",
    fails: ["`<boardId>`, `<cardId>` or `<stageKey>` is missing"],
    examples: ["supi move brd_8f2c… crd_41aa… review"],
  },
  {
    path: ["archive"],
    group: "cards",
    args: [BOARD, CARD],
    flags: [],
    summary: "archive a card, so the \"show archived\" filter has something to show",
    description: "Archives a card now. It leaves the board's lanes and appears under the web app's \"show archived\" filter.",
    routes: [{ method: "PATCH", path: "/v1/boards/:boardId/cards/:cardId" }],
    access: { role: "member", agent: "plan" },
    output: "JSON: the archived card",
    fails: ["`<boardId>` or `<cardId>` is missing"],
    examples: ["supi archive brd_8f2c… crd_41aa…"],
  },
  {
    path: ["log"],
    group: "cards",
    args: [BOARD, CARD],
    flags: [],
    summary: "what an agent did on a card, and its handoff",
    description: "The card's activity transcript — what each agent posted, in order — its handoff, and its gates.",
    routes: [{ method: "GET", path: "/v1/boards/:boardId/cards/:cardId/activities" }],
    access: { role: "viewer", agent: "read" },
    output: "the transcript, readable; `--json` for the server's response",
    fails: ["`<boardId>` or `<cardId>` is missing"],
    examples: ["supi log brd_8f2c… crd_41aa…"],
  },

  // ── gates ────────────────────────────────────────────────────────────────────────────────────
  {
    path: ["gates"],
    group: "gates",
    args: [BOARD],
    flags: [],
    summary: "approval gates waiting on a human",
    description: "Every gate on the board that is open and waiting for a decision, with the card it holds.",
    routes: [{ method: "GET", path: "/v1/boards/:boardId/gates/pending" }],
    access: { role: "viewer", agent: "any" },
    output: "one gate per line; `--json` for the server's response",
    fails: ["`<boardId>` is missing"],
    examples: ["supi gates brd_8f2c…"],
  },
  {
    path: ["approve"],
    group: "gates",
    args: [BOARD, GATE],
    flags: [COMMENT],
    summary: "approve a gate: the card moves on",
    description: "Approves the gate. The card advances to the next stage; if that stage is gated too, a new gate opens on the same run.",
    routes: [{ method: "POST", path: "/v1/boards/:boardId/gates/:gateId/resolve" }],
    access: { role: "member", agent: "refused" },
    output: "JSON: the resolved gate",
    fails: ["`<boardId>` or `<gateId>` is missing"],
    examples: ['supi approve brd_8f2c… gat_19c0… --comment "checked the diff"'],
  },
  {
    path: ["reject"],
    group: "gates",
    args: [BOARD, GATE],
    flags: [COMMENT],
    summary: "reject a gate",
    description: "Rejects the gate. The card stops in the `rejected` state where it stands — refused, not returned for rework. Use `request-changes` to send it back.",
    routes: [{ method: "POST", path: "/v1/boards/:boardId/gates/:gateId/resolve" }],
    access: { role: "member", agent: "refused" },
    output: "JSON: the resolved gate",
    fails: ["`<boardId>` or `<gateId>` is missing"],
    examples: ['supi reject brd_8f2c… gat_19c0… --comment "out of scope"'],
  },
  {
    path: ["request-changes"],
    group: "gates",
    args: [BOARD, GATE],
    flags: [{ ...COMMENT, value: '"what to change"', required: true, default: undefined, description: "what to change. It becomes the rework instruction the next run reads" }],
    summary: "send the card back for rework, saying what to change",
    description:
      "Returns the card to the stage the gate names for rework, where it is claimable again. The comment is required: it is merged into the handoff the next run reads, so a " +
      "request with nothing said would re-queue the work with no instruction.",
    routes: [{ method: "POST", path: "/v1/boards/:boardId/gates/:gateId/resolve" }],
    access: { role: "member", agent: "refused" },
    output: "JSON: the resolved gate",
    fails: ["`<boardId>` or `<gateId>` is missing", "`--comment` is missing (`request-changes needs a reason.`)"],
    examples: ['supi request-changes brd_8f2c… gat_19c0… --comment "add a test for the expired-token path"'],
  },

  // ── links ────────────────────────────────────────────────────────────────────────────────────
  {
    path: ["link", "add"],
    group: "links",
    args: [BOARD, { name: "fromCardId", description: "the card the edge starts at" }, { name: "toCardId", description: "the card the edge points to" }],
    flags: [LINK_KIND, TO_BOARD],
    summary: "declare an edge between two cards",
    description:
      "Declares an edge from one card to another. `<boardId>` is the from-card's board. A same-board `blocks` edge " +
      "stops the blocked card being claimed until its blocker is done; with `--to-board` the edge crosses boards " +
      "and is advisory only.",
    routes: [{ method: "POST", path: "/v1/boards/:boardId/links" }],
    access: { role: "member", agent: "plan" },
    output: "JSON: the edge; a cross-board edge is preceded by a notice that it is advisory",
    fails: ["a card id is missing", "`--kind` is missing or not one of `blocks`, `relates`, `parent`"],
    examples: [
      "supi link add brd_8f2c… crd_41aa… crd_77b3… --kind blocks",
      "supi link add brd_8f2c… crd_41aa… crd_0d1e… --kind relates --to-board brd_93fa…",
    ],
  },
  {
    path: ["link", "rm"],
    group: "links",
    args: [BOARD, { name: "fromCardId", description: "the card the edge starts at" }, { name: "toCardId", description: "the card the edge points to" }],
    flags: [LINK_KIND, TO_BOARD],
    summary: "remove an edge",
    description: "Removes the edge with exactly this from-card, to-card and kind.",
    routes: [{ method: "DELETE", path: "/v1/boards/:boardId/links" }],
    access: { role: "member", agent: "plan" },
    output: "JSON: the server's response",
    fails: ["a card id is missing", "`--kind` is missing or not one of `blocks`, `relates`, `parent`"],
    examples: ["supi link rm brd_8f2c… crd_41aa… crd_77b3… --kind blocks"],
  },
  {
    path: ["link", "list"],
    group: "links",
    args: [BOARD, CARD],
    flags: [],
    summary: "every edge touching a card — same-board and cross-board, kept apart",
    description: "Every edge touching the card, with the enforced same-board edges and the advisory cross-board edges kept apart.",
    routes: [{ method: "GET", path: "/v1/boards/:boardId/cards/:cardId/links" }],
    access: { role: "viewer", agent: "refused", note: "Not open to agent tokens today." },
    output: "JSON: the card's edges",
    fails: ["`<boardId>` or `<cardId>` is missing"],
    examples: ["supi link list brd_8f2c… crd_41aa…"],
  },

  // ── labels ───────────────────────────────────────────────────────────────────────────────────
  {
    path: ["label", "list"],
    group: "labels",
    args: [],
    flags: [],
    summary: "the workspace's label catalogue",
    description: "Every label declared in the workspace, with its id and colour.",
    routes: [{ method: "GET", path: "/v1/labels" }],
    access: { role: "viewer", agent: "read" },
    output: "JSON: the labels",
    fails: [],
    examples: ["supi label list"],
  },
  {
    path: ["label", "add"],
    group: "labels",
    args: [{ name: "name", description: "the label's name" }, { name: "colour", description: "its colour, as the web app accepts it (for example `#d97706`)" }],
    flags: [],
    summary: "declare a label",
    description: "Declares a label in the workspace catalogue, so cards can be tagged with it by id (`create-card --label`).",
    routes: [{ method: "POST", path: "/v1/labels" }],
    access: { role: "admin", agent: "refused" },
    output: "JSON: the created label",
    fails: ["`<name>` or `<colour>` is missing"],
    examples: ["supi label add security '#dc2626'"],
  },
  {
    path: ["label", "rm"],
    group: "labels",
    args: [{ name: "id", description: "the label's id (see `supi label list`)" }],
    flags: [],
    summary: "remove a label (cards keep the stale id)",
    description: "Removes a label. Cards that carried it keep the id and show nothing for it.",
    routes: [{ method: "DELETE", path: "/v1/labels/:id" }],
    access: { role: "admin", agent: "refused" },
    output: "`Deleted <id>.`; `--json` for `{ deleted }`",
    fails: ["`<id>` is missing"],
    examples: ["supi label rm lbl_sec"],
  },

  // ── projects ─────────────────────────────────────────────────────────────────────────────────
  {
    path: ["project", "list"],
    group: "projects",
    args: [],
    flags: [],
    summary: "the workspace's projects (group cards across boards)",
    description: "Every project in the workspace, with its target date and lead. A project groups cards from any board.",
    routes: [{ method: "GET", path: "/v1/projects" }],
    access: { role: "viewer", agent: "read" },
    output: "one project per line; `--json` for the server's response",
    fails: [],
    examples: ["supi project list"],
  },
  {
    path: ["project", "add"],
    group: "projects",
    args: [{ name: "name", description: "the project's name" }],
    flags: [
      { name: "--description", value: "<text>", type: "string", default: "none", description: "what the project is for" },
      { name: "--target", value: "YYYY-MM-DD", type: "date", default: "no target date", description: `the target date; ${DATE_FORMAT}` },
      { name: "--lead", value: "<userId>", type: "string", default: "no lead", description: "the person who leads it" },
    ],
    summary: "declare a project",
    description: "Declares a project in the workspace. Cards from any board can then be grouped under it.",
    routes: [{ method: "POST", path: "/v1/projects" }],
    access: { role: "admin", agent: "plan" },
    output: "JSON: the created project",
    fails: ["`<name>` is missing", "`--target` is not `YYYY-MM-DD`"],
    examples: ["supi project add 'Q4 hardening' --target 2026-12-15 --description 'auth and tenancy fixes'"],
  },
  {
    path: ["project", "show"],
    group: "projects",
    args: [{ name: "projectId", description: "the project (see `supi project list`)" }],
    flags: [],
    summary: "a project with its milestones, in order",
    description: "One project and its milestones, ordered by their sort order and then by name.",
    routes: [{ method: "GET", path: "/v1/projects/:projectId" }],
    access: { role: "viewer", agent: "read" },
    output: "the project and its milestones; `--json` for the server's response",
    fails: ["`<projectId>` is missing"],
    examples: ["supi project show prj_5b10…"],
  },
  {
    path: ["project", "rm"],
    group: "projects",
    args: [{ name: "projectId", description: "the project" }],
    flags: [],
    summary: "remove a project (cards keep the stale id)",
    description: "Removes a project. Cards that carried it keep the id and show nothing for it.",
    routes: [{ method: "DELETE", path: "/v1/projects/:projectId" }],
    access: { role: "admin", agent: "refused" },
    output: "`Deleted <projectId>.`; `--json` for `{ deleted }`",
    fails: ["`<projectId>` is missing"],
    examples: ["supi project rm prj_5b10…"],
  },
  {
    path: ["milestone", "add"],
    group: "projects",
    args: [{ name: "projectId", description: "the project it belongs to" }, { name: "name", description: "the milestone's name" }],
    flags: [
      { name: "--target", value: "YYYY-MM-DD", type: "date", default: "no target date", description: `the target date; ${DATE_FORMAT}` },
      { name: "--sort", value: "<n>", type: "number", default: "the server's default order", description: "its position within the project, ascending" },
    ],
    summary: "add a milestone to a project",
    description: "Adds a milestone to a project. Milestones are shown in `--sort` order, then by name.",
    routes: [{ method: "POST", path: "/v1/projects/:projectId/milestones" }],
    access: { role: "admin", agent: "plan" },
    output: "JSON: the created milestone",
    fails: ["`<projectId>` or `<name>` is missing", "`--target` is not `YYYY-MM-DD`, or `--sort` is not a number"],
    examples: ["supi milestone add prj_5b10… 'Beta' --target 2026-11-15 --sort 1"],
  },
  {
    path: ["milestone", "rm"],
    group: "projects",
    args: [{ name: "milestoneId", description: "the milestone (see `supi project show`)" }],
    flags: [],
    summary: "remove a milestone (cards keep the stale id)",
    description: "Removes one milestone without touching its project. Cards that carried it keep the id.",
    routes: [{ method: "DELETE", path: "/v1/milestones/:milestoneId" }],
    access: { role: "admin", agent: "refused" },
    output: "`Deleted <milestoneId>.`; `--json` for `{ deleted }`",
    fails: ["`<milestoneId>` is missing"],
    examples: ["supi milestone rm mst_2c7e…"],
  },

  // ── schedules ────────────────────────────────────────────────────────────────────────────────
  {
    path: ["schedule", "list"],
    group: "schedules",
    args: [BOARD],
    flags: [],
    summary: "the board's recurring cards",
    description: "Every schedule on the board, enabled or paused.",
    routes: [{ method: "GET", path: "/v1/boards/:boardId/schedules" }],
    access: { role: "viewer", agent: "refused", note: "Not open to agent tokens today." },
    output: "JSON: the schedules",
    fails: ["`<boardId>` is missing"],
    examples: ["supi schedule list brd_8f2c…"],
  },
  {
    path: ["schedule", "add"],
    group: "schedules",
    args: [BOARD],
    flags: [
      { name: "--title", value: "<t>", type: "string", required: true, description: "the title each card it creates carries" },
      {
        name: "--rule",
        value: "<r>",
        type: "string",
        required: true,
        description:
          'the cadence: `every <n> minutes|hours|days`, `daily at HH:MM`, `weekly on <mon-sun> at HH:MM`, or ' +
          "`monthly on <1-28> at HH:MM`. The server checks the grammar and its refusal says what to type instead",
      },
      { name: "--tz", value: "<tz>", type: "string", required: true, description: "the IANA time zone the rule's times are in, such as `Europe/London`" },
      { name: "--stage", value: "<key>", type: "string", default: "the board's first stage", description: "the stage each card is created in" },
      { name: "--priority", value: "<n>", type: "number", default: "`0`", description: "each card's priority" },
      {
        name: "--overlap",
        value: "skip|allow",
        type: "enum",
        choices: ["skip", "allow"],
        default: "`skip`",
        description: "`skip`: do not create a card while the previous one is still open; `allow`: create it anyway",
      },
    ],
    summary: "declare a schedule",
    description: "Declares a schedule that creates a card on the board each time its rule fires.",
    routes: [{ method: "POST", path: "/v1/boards/:boardId/schedules" }],
    access: { role: "admin", agent: "refused" },
    output: "JSON: the created schedule",
    fails: ["`<boardId>`, `--title`, `--rule` or `--tz` is missing", "`--overlap` is not `skip` or `allow`"],
    examples: [
      "supi schedule add brd_8f2c… --title 'Weekly dependency audit' --rule 'weekly on mon at 09:00' --tz Europe/London",
      "supi schedule add brd_8f2c… --title 'Triage inbox' --rule 'every 4 hours' --tz UTC --overlap skip",
    ],
  },
  {
    path: ["schedule", "rm"],
    group: "schedules",
    args: [BOARD, SCHEDULE],
    flags: [],
    summary: "remove a schedule",
    description: "Removes a schedule. Cards it already created are untouched.",
    routes: [{ method: "DELETE", path: "/v1/boards/:boardId/schedules/:scheduleId" }],
    access: { role: "admin", agent: "refused" },
    output: "`Deleted <scheduleId>.`; `--json` for `{ deleted }`",
    fails: ["`<boardId>` or `<scheduleId>` is missing"],
    examples: ["supi schedule rm brd_8f2c… sch_3a9d…"],
  },
  {
    path: ["schedule", "pause"],
    group: "schedules",
    args: [BOARD, SCHEDULE],
    flags: [],
    summary: "stop a schedule firing, keeping it",
    description: "Disables a schedule without removing it: it creates no cards until `schedule resume`.",
    routes: [{ method: "PATCH", path: "/v1/boards/:boardId/schedules/:scheduleId" }],
    access: { role: "admin", agent: "refused" },
    output: "JSON: the schedule",
    fails: ["`<boardId>` or `<scheduleId>` is missing"],
    examples: ["supi schedule pause brd_8f2c… sch_3a9d…"],
  },
  {
    path: ["schedule", "resume"],
    group: "schedules",
    args: [BOARD, SCHEDULE],
    flags: [],
    summary: "start a paused schedule firing again",
    description: "Re-enables a paused schedule, so its rule creates cards again.",
    routes: [{ method: "PATCH", path: "/v1/boards/:boardId/schedules/:scheduleId" }],
    access: { role: "admin", agent: "refused" },
    output: "JSON: the schedule",
    fails: ["`<boardId>` or `<scheduleId>` is missing"],
    examples: ["supi schedule resume brd_8f2c… sch_3a9d…"],
  },

  // ── workspace ────────────────────────────────────────────────────────────────────────────────
  {
    path: ["forge"],
    group: "workspace",
    args: [{ name: "host|none", description: "a Forgejo host to set, or `none` to clear it; omit to show the current one", optional: true }],
    flags: [],
    synopsis: "supi forge [<host>|none]",
    summary: "this workspace's forge host, shown or set",
    description:
      "Shows or sets the workspace's forge host. GitHub needs no configuration; a self-hosted Forgejo does, and " +
      "until it is set a link to one of its repositories is stored as a plain URL — with no durable id for events " +
      "to match.",
    routes: [
      { method: "GET", path: "/v1/tenant/forge" },
      { method: "PUT", path: "/v1/tenant/forge" },
    ],
    access: { role: "viewer", agent: "refused", note: "Showing needs `viewer`; setting or clearing needs `admin`." },
    output: "`forge <host>`, `No forge configured.` or `Forge cleared.`; `--json` for `{ forgeHost }`",
    fails: [],
    examples: ["supi forge", "supi forge git.example.com", "supi forge none"],
  },
  {
    path: ["agents"],
    group: "workspace",
    args: [],
    flags: [],
    summary: "the workspace's agents and what they declare",
    description:
      "Every agent in the workspace with the capabilities it declares, its token ids (never a token) and its " +
      "queueing policy.",
    routes: [{ method: "GET", path: "/v1/agents" }],
    access: { role: "viewer", agent: "read" },
    output: "JSON: the agents",
    fails: [],
    examples: ["supi agents"],
  },
  {
    path: ["agent", "queueing"],
    group: "workspace",
    args: [{ name: "agentId", description: "the agent (see `supi agents`)" }],
    flags: [
      {
        name: "--owner",
        value: "<userId>|none",
        type: "string",
        default: "unchanged",
        description: "the person whose work the agent's own cards are; `none` clears it",
      },
      {
        name: "--boards",
        value: "<id,id,…>|none",
        type: "list",
        default: "unchanged",
        description:
          "the boards the agent may queue onto, comma-separated. `none` — which is also every agent's starting " +
          "state — means NO board, not every board",
      },
      {
        name: "--ceiling",
        value: "<n>",
        type: "integer",
        default: "unchanged",
        description: "the most cards it may queue in an hour; a whole number of at least 1",
      },
    ],
    summary: "what an agent may queue of its OWN: owner, boards, cards an hour",
    description:
      "Sets the three bounds on an agent that queues work of its own. At least one flag is required; a flag left " +
      "out is left unchanged, and clearing is always typed (`none`), never inferred from an empty value. The " +
      "dispatch grant itself is not set here — it arrives in the agent's token from the fleet that issued it.",
    routes: [{ method: "PATCH", path: "/v1/agents/:agentId" }],
    access: { role: "admin", agent: "refused" },
    output: "JSON: the agent",
    fails: ["`<agentId>` is missing, or the sub-verb is not `queueing`", "no flag is given", "`--ceiling` is not a whole number of at least 1"],
    examples: ["supi agent queueing agt_c4d2… --owner usr_19a0… --boards brd_8f2c…,brd_93fa… --ceiling 6", "supi agent queueing agt_c4d2… --boards none"],
  },
  {
    path: ["capabilities"],
    group: "workspace",
    args: [],
    flags: [],
    summary: "the capability registry, with each one's origin",
    description:
      "Every capability the workspace knows, and where each came from — declared by a person, or inferred because a " +
      "stage asked for it. A capability a stage names and no agent holds is a lane nothing can claim.",
    routes: [{ method: "GET", path: "/v1/capabilities" }],
    access: { role: "viewer", agent: "read" },
    output: "JSON: the capabilities",
    fails: [],
    examples: ["supi capabilities"],
  },
  {
    path: ["implications"],
    group: "workspace",
    args: [],
    flags: [],
    summary: "what one capability implies about another",
    description:
      "The implication edges between capabilities. An agent's effective capability set is what it declares plus " +
      "everything those imply, and routing compares a stage's owner against that set.",
    routes: [{ method: "GET", path: "/v1/capabilities/implications" }],
    access: { role: "viewer", agent: "refused", note: "Not open to agent tokens today." },
    output: "JSON: the edges",
    fails: [],
    examples: ["supi implications"],
  },
];

/** Flags every command accepts. */
export const GLOBAL_FLAGS: FlagSpec[] = [
  {
    name: "--json",
    type: "boolean",
    default: "off: readable output where a renderer exists",
    description:
      "machine-stable JSON, on any command. A response with no readable renderer prints JSON either way",
  },
  {
    name: "--help",
    type: "boolean",
    default: "off",
    description: "print this command's help instead of running it",
  },
];

export interface EnvSpec {
  name: string;
  description: string;
  /** Read by the release installer, not by `supi`. */
  installer?: boolean;
}

/** Every environment variable `supi` or its installer reads. `reference.test.ts` holds this to the source. */
export const ENV_VARS: EnvSpec[] = [
  {
    name: "SUPERPIPELINE_AGENT_TOKEN_FILE",
    description:
      "a FILE holding an agent credential, re-read on every run. Outranks every other credential. Named but missing " +
      "or empty is a refusal, never a fall-back to somebody else's credential",
  },
  {
    name: "SUPERPIPELINE_AGENT_TOKEN",
    description:
      "an agent credential: an `spa_…` token, or an agent JWT. A person's token here is refused by its kind",
  },
  {
    name: "SUPERPIPELINE_TOKEN",
    description:
      "a person's token, used as supplied: never renewed, never replaced. An `spa_` token here is refused — it " +
      "belongs in `SUPERPIPELINE_AGENT_TOKEN`",
  },
  {
    name: "AGENTPOD_TOKEN",
    description:
      "a person's AgentPod hub token, used as supplied. Only a server still verifying hub tokens accepts it; " +
      "app.superpipeline.dev refuses it, so do not export it into a shell that runs `supi` — it outranks " +
      "`supi login` and every command would answer 401",
  },
  {
    name: "SUPERPIPELINE_URL",
    description:
      "the superpipeline server to talk to. Default `https://app.superpipeline.dev`. It changes where commands go " +
      "and which audience a token is requested for, never where a device credential is sent",
  },
  {
    name: "XDG_CONFIG_HOME",
    description: "Linux: the config directory credentials live under (default `~/.config`)",
  },
  { name: "APPDATA", description: "Windows: the config directory credentials live under" },
  { name: "BIN_DIR", description: "where the installer puts `supi` and `superpipeline` (default `~/.local/bin`)", installer: true },
  { name: "VERSION", description: "a release tag for the installer to pin, instead of the latest", installer: true },
  { name: "SKILL_DIR", description: "where the installer also places the agent skill; unset, no skill is installed", installer: true },
];

export const ROLE_TEXT: Record<Role, string> = {
  viewer: "`viewer` or above",
  member: "`member` or above",
  admin: "`admin` or above",
  owner: "`owner`",
};

export function commandName(c: CommandSpec): string {
  return `supi ${c.path.join(" ")}`;
}

function flagSynopsis(f: FlagSpec): string {
  const body = f.value ? `${f.name} ${f.value}` : f.name;
  const shown = f.repeatable ? `${body}...` : body;
  return f.required ? shown : `[${shown}]`;
}

export function synopsis(c: CommandSpec): string {
  if (c.synopsis) return c.synopsis;
  const args = c.args.map((a) => (a.optional ? `[<${a.name}>]` : `<${a.name}>`));
  return [commandName(c), ...args, ...c.flags.map(flagSynopsis)].join(" ");
}

/** The commands a verb names: one for `board`, several for `link`. */
export function findCommands(words: string[]): CommandSpec[] {
  const [verb, sub] = words;
  const byVerb = COMMANDS.filter((c) => c.path[0] === verb);
  if (sub) {
    const exact = byVerb.filter((c) => c.path[1] === sub);
    if (exact.length > 0) return exact;
  }
  return byVerb;
}

/** Wrap `text` to `width`, every line after the first indented by `indent`. */
function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") out.push(line);
  return out.map((l, i) => (i === 0 ? l : indent + l));
}

/** A synopsis broken between its words and bracketed options, never inside a `[...]`. */
function wrapSynopsis(syn: string, width: number, indent: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const token of syn.match(/\[[^\]]*\]|\S+/g) ?? []) {
    if (line !== "" && line.length + 1 + token.length > width) {
      out.push(line);
      line = indent + token;
    } else {
      line = line === "" ? token : `${line} ${token}`;
    }
  }
  if (line !== "") out.push(line);
  return out;
}

/** Backticks are for the docs; a terminal shows them as noise. */
const plain = (s: string) => s.replace(/`/g, "");

/** The summary `supi help` prints. */
export function renderUsage(): string {
  const lines: string[] = ["supi — superpipeline from a terminal (`superpipeline` is the same command)", ""];
  for (const g of GROUPS) {
    lines.push(`${g.title}:`);
    for (const c of COMMANDS.filter((x) => x.group === g.id)) {
      const syn = synopsis(c);
      if (syn.length <= 34) {
        lines.push(`  ${syn.padEnd(34)} ${plain(c.summary)}`);
      } else {
        for (const l of wrapSynopsis(syn, 94, "      ")) lines.push(`  ${l}`);
        lines.push(`  ${"".padEnd(34)} ${plain(c.summary)}`);
      }
    }
    lines.push("");
  }
  lines.push(
    "  --json                             machine-stable output, on any command",
    "  supi help <verb> [<sub-verb>]      one command in full (or: supi <verb> --help)",
    "",
    "Credential, first found wins: $SUPERPIPELINE_AGENT_TOKEN_FILE, $SUPERPIPELINE_AGENT_TOKEN,",
    "$SUPERPIPELINE_TOKEN, $AGENTPOD_TOKEN, `supi login`'s cached token, `supi login`'s device",
    "credential (exchanged at the sign-in service), then `fleet login`'s token and device.",
    "An agent acts with $SUPERPIPELINE_AGENT_TOKEN_FILE (a file, re-read every run) or",
    "$SUPERPIPELINE_AGENT_TOKEN, either outranking every person's credential. An spa_ token reads",
    "and plans; only an agent JWT (a station token) carries the dispatch grant that queues work and",
    "moves cards, and it lives minutes — so point the FILE at something that keeps it fresh.",
    "",
    "What you may do is your role in the workspace, which the server decides — not this command.",
    "A refusal comes back as a 403 and is printed as it arrives. Exit status: 0 on success, 1 otherwise.",
    "Reference: https://docs.superpipeline.dev/reference/cli/",
  );
  return lines.join("\n");
}

function accessLines(a: Access): string[] {
  if (a.role === null && a.agent === null) return [a.note ?? "Local: sends no credential to superpipeline."];
  const out: string[] = [];
  if (a.role) out.push(`a person: ${ROLE_TEXT[a.role]} in the workspace`);
  if (a.agent === "any") out.push("an agent token: any, no scope needed");
  else if (a.agent === "refused") out.push("an agent token: refused");
  else if (a.agent) out.push(`an agent token: the \`${a.agent}\` scope`);
  if (a.note) out.push(a.note);
  return out;
}

/** `supi help <verb>`: one command in full. */
export function renderCommandHelp(c: CommandSpec): string {
  const lines: string[] = [...wrapSynopsis(plain(synopsis(c)), 96, "    "), ""];
  for (const para of c.description.split("\n\n")) lines.push(...wrap(plain(para), 96, ""), "");
  if (c.args.length > 0) {
    lines.push("Arguments:");
    for (const a of c.args) lines.push(`  <${a.name}>`.padEnd(24) + wrap(plain(a.description), 72, "".padEnd(24)).join("\n"));
    lines.push("");
  }
  if (c.flags.length > 0) {
    lines.push("Flags:");
    for (const f of c.flags) {
      const head = `  ${f.value ? `${f.name} ${f.value}` : f.name}`;
      const detail = [
        plain(f.description),
        f.required ? "Required." : f.default ? `Default: ${plain(f.default)}.` : "",
        f.repeatable ? "Repeatable." : "",
      ]
        .filter((s) => s !== "")
        .join(". ")
        .replace(/\.\./g, ".");
      if (head.length < 30) lines.push(head.padEnd(30) + wrap(detail, 66, "".padEnd(30)).join("\n"));
      else lines.push(head, "".padEnd(30) + wrap(detail, 66, "".padEnd(30)).join("\n"));
    }
    lines.push("");
  }
  lines.push("Who may run it:");
  for (const l of accessLines(c.access)) lines.push(...wrap(plain(l), 94, "    ").map((x, i) => (i === 0 ? `  ${x}` : x)));
  lines.push("");
  if (c.routes.length > 0) {
    lines.push("Calls:");
    for (const r of c.routes) lines.push(`  ${r.method} ${r.path}`);
    lines.push("");
  }
  lines.push("Examples:");
  for (const e of c.examples) lines.push(`  ${e}`);
  return lines.join("\n");
}
