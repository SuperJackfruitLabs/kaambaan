#!/usr/bin/env bun
/**
 * `supi` — superpipeline from a terminal.
 *
 * Installed under two names, `superpipeline` and `supi`, pointing at this one file: the full
 * name for scripts and documentation a stranger reads, the short one for a person typing.
 * It was `kbn` until the product was renamed; that name was short for the old one.
 *
 * The third consumer of `@superpipeline/contract`, after REST and MCP. It is a client: it adds no
 * authority, performs no local permission check, and renders the board's own refusals. A client
 * that pre-empts a server decision is a client that will one day disagree with it.
 *
 * **The verbs used to be work verbs only, and the reason given for that is no longer true.**
 * The text here said a hub token "resolves as a `member`", so managing anything needed a seat
 * the token did not grant. That was accurate until 2026-09-20, when superpipeline learned to map an
 * issuer subject onto a local user (`apps/api/src/auth/hub-oauth.ts`): a mapped principal reads
 * its real membership, and for the person who owns the workspace that is `owner`. The seat was
 * never withheld from the CLI — it did not exist yet.
 *
 * So `create-board` is here. It is still a client: it adds no authority, performs no local
 * permission check, and renders the board's own refusals. A caller with no seat gets a 403 from
 * the server, which is where that decision belongs — a client that pre-empts a server decision
 * is a client that will one day disagree with it, and this file spent a release disagreeing.
 */
import { readFileSync } from "node:fs";
import { BOARD_TEMPLATES, boardTemplate, type BoardTemplateStage } from "@superpipeline/contract";
import { baseUrl, describeCredential, expired, inspect, resolveCredential, ENV_AGENT_TOKEN, ENV_TOKEN } from "./credential.ts";
import { renderBoards, renderBoard, renderGates, renderLog, renderProjects, renderProject } from "./render.ts";
import { flag, flags, positionals } from "./args.ts";
import { VERSION, runUpdate } from "./update.ts";

const USAGE = `supi — superpipeline from a terminal (\`superpipeline\` is the same command)

  supi whoami                  who the stored token says you are
  supi boards                  the workspace's boards
  supi board <boardId>         one board: its stages and their cards
  supi card <boardId> <cardId> one card in full
  supi move <boardId> <cardId> <stageKey>
                               move a card to another stage
  supi gates <boardId>         approval gates waiting on a human
  supi approve <boardId> <gateId> [--comment "why"]
  supi reject <boardId> <gateId> [--comment "why"]
  supi request-changes <boardId> <gateId> --comment "what to change"
                               decide a gate without leaving the terminal
  supi log <boardId> <cardId>  what an agent did on a card, and its handoff
  supi archive <boardId> <cardId>
                               archive a card, so the "show archived" filter has something to show
  supi link add <boardId> <fromCardId> <toCardId> --kind blocks|relates|parent
                               [--to-board <boardId>]
                               declare an edge; --to-board names another board for an
                               advisory (not enforced) cross-board edge
  supi link rm <boardId> <fromCardId> <toCardId> --kind blocks|relates|parent
                               [--to-board <boardId>]
                               remove one
  supi link list <boardId> <cardId>
                               every edge touching a card — same-board (enforced) and
                               cross-board (advisory), kept apart

  supi create-board <name> [--template <id>] [--stages <file|->]
                               create a board; --template defaults to \`simple\`
  supi set-stages <boardId> <file|->
                               replace a board's pipeline
  supi set-stage <boardId> <stageKey> [--instructions <file|->] [--name ...]
                               [--completion <file|->] [--clear-completion]
                               change ONE stage, leaving the others alone
  supi create-card <boardId> <title> [--spec <file|->] [--priority <n>]
                               [--due YYYY-MM-DD] [--label <id>]...
                               queue a card, with this token as its grant
  supi templates               the starting pipelines --template accepts

  supi label list               the tenant's label catalogue
  supi label add <name> <colour>
                               declare a label
  supi label rm <id>           remove a label (cards keep the stale id)

  supi project list            the workspace's projects (group cards across boards)
  supi project add <name> [--description <text>] [--target YYYY-MM-DD] [--lead <userId>]
                               declare a project
  supi project show <projectId>
                               a project with its milestones, in order
  supi project rm <projectId>  remove a project (cards keep the stale id)
  supi milestone add <projectId> <name> [--target YYYY-MM-DD] [--sort <n>]
                               add a milestone to a project
  supi milestone rm <milestoneId>
                               remove a milestone (cards keep the stale id)

  supi schedule list <boardId> the board's recurring cards
  supi schedule add <boardId> --title <t> --rule <r> --tz <tz>
                               [--stage <key>] [--priority <n>] [--overlap skip|allow]
                               declare a schedule; rule is "every <n> minutes|hours|days",
                               "daily at HH:MM", "weekly on <mon-sun> at HH:MM", or
                               "monthly on <1-28> at HH:MM" — checked every five minutes,
                               so it may fire up to five minutes after its stated time
  supi schedule rm <boardId> <scheduleId>
                               remove a schedule
  supi schedule pause <boardId> <scheduleId>
  supi schedule resume <boardId> <scheduleId>

  supi forge [<host>|none]     this workspace's forge host, shown or set
  supi agents                  the workspace's agents and what they declare
  supi agent queueing <agentId> [--owner <userId>|none] [--boards <id,id,…>|none]
                               [--ceiling <n>]
                               what an agent may queue of its OWN: whose work it owns,
                               which boards may receive it, how many cards an hour.
                               --boards none is the default and means NO board
  supi capabilities            the capability registry, with each one's origin
  supi implications            what one capability implies about another

  supi update [--check]        replace this binary with the newest release
  supi version                 print this binary's version

  --json                       machine-stable output, on any command (the default is
                               readable; a shape with no renderer prints JSON either way)

Credential: $${ENV_TOKEN}, else $AGENTPOD_TOKEN, else the token \`fleet login\` writes.
An agent acts with $${ENV_AGENT_TOKEN} (spa_…), which outranks all three. It reads
boards and queues cards; everything else on this list stays a person's.
Expired file tokens renew through the device credential from fleet login.
Explicit environment tokens are used as supplied; superpipeline verifies them offline.

Not here: staffing agents, editing capabilities, changing the fleet link.
What you may do is your seat in the workspace, which the server decides — not this
command. A refusal comes back as a 403 and is printed as it arrives.`;

/**
 * `create-card --due`'s own shape check, matching the API's (`DUE_AT_RE`, apps/api/src/index.ts).
 * Checked here rather than left to the server: a malformed value never leaves the terminal, so the
 * person sees this message instead of the API's 400 — a worse sentence for the same mistake.
 */
const DUE_AT_RE = /^\d{4}-\d{2}-\d{2}$/;

function wantsJson(args: string[]): boolean {
  return args.includes("--json");
}

function fail(message: string, hint?: string): never {
  process.stderr.write(message + "\n");
  if (hint) process.stderr.write("\n" + hint + "\n");
  process.exit(1);
}

async function credentialOrExit() {
  let c;
  try {
    c = await resolveCredential();
  } catch (error) {
    fail(error instanceof Error ? error.message : "Could not read fleet credentials.");
  }
  if (!c) {
    fail(
      "Not signed in.",
      `  fleet login          sign in once, for both planes\n` +
        `  ${ENV_TOKEN}=…   supply a token directly\n` +
        `  ${ENV_AGENT_TOKEN}=spa_…   act as an agent, not as a person`,
    );
  }
  // An agent's token is an opaque secret with no claims and no expiry to read. Running it through
  // the expiry check below would find none and pass, which is the right outcome by accident; saying
  // so is better than relying on it.
  if (c.kind === "agent") return c;
  const claims = inspect(c.token);
  if (claims && expired(claims)) {
    const hint = c.source.startsWith("env:")
      ? `Replace or unset ${c.source.slice(4)}; explicit tokens are not renewed.`
      : "fleet login";
    fail(`Your session expired at ${claims.expiry!.toLocaleString()}.`, `  ${hint}`);
  }
  return c;
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const c = await credentialOrExit();
  const res = await fetch(baseUrl() + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();

  if (res.status === 401) {
    fail("superpipeline did not accept that token (401).", "  fleet login");
  }
  if (res.status === 403) {
    // Distinguished from 401 deliberately: 401 means sign in, 403 means you may not — and telling
    // a person to sign in again when the answer is "your seat does not permit this" sends them
    // round a loop.
    //
    // The hint used to assert that a hub token "acts as a `member`", full stop. That stopped
    // being true on 2026-09-20: a token whose subject is mapped to a local user reads that
    // user's real role. `member` is now the FALLBACK for an unmapped principal, not a ceiling,
    // so the honest hint names the thing that is actually missing.
    fail(
      `Refused by superpipeline (403). ${body.trim()}`,
      "Your seat in this workspace does not permit that.\n" +
        "An AgentPod identity reads as `member` until it is linked to a superpipeline account —\n" +
        "sign in once at the web app with the same address to link them. See packages/cli/README.md.",
    );
  }
  if (!res.ok) fail(`superpipeline returned ${res.status}: ${body.trim()}`);

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * Set once from the argv in `main`, read by `out`.
 *
 * A module-level flag rather than a parameter threaded through every case: the alternative is
 * passing `json` to twenty call sites, where forgetting one produces a command that silently
 * ignores `--json` — the exact defect this change exists to fix.
 */
let wantJson = false;

/**
 * Print a response: readable by default, JSON on request.
 *
 * A shape with no renderer still prints JSON, so adding a command never waits on a formatter
 * being written for it. That fallback is why this could change the default without auditing
 * every verb first.
 */
const out = (value: unknown, human?: (v: unknown) => string) => {
  if (!wantJson && human) {
    process.stdout.write(human(value) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
};

/** A named template's stages, or a refusal that lists the ones that exist. */
function stagesFromTemplate(id: string): BoardTemplateStage[] {
  const template = boardTemplate(id);
  if (!template) {
    fail(
      `No template named \`${id}\`.`,
      "  supi templates           the ones that exist",
    );
  }
  return template.stages;
}

/**
 * Stages read from a JSON file, or from stdin when the path is `-`.
 *
 * Shape-checked only as far as "an array of objects with a key": the board is the authority on
 * what a valid pipeline is, and a client that re-implements that check is a client that will one
 * day refuse something the server would have accepted. What this catches is the file being the
 * wrong *kind* of thing — a board snapshot, a card list, an error page saved by mistake — where
 * the server's own message would be about fields the person never typed.
 */
/** A file's text, or stdin for `-`. Unlike `stagesFromFile` the content is prose, not JSON. */
function readText(path: string): string {
  try {
    return (path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8")).trim();
  } catch {
    fail(`Could not read ${path === "-" ? "stdin" : path}.`);
  }
}

async function stagesFromFile(path: string): Promise<BoardTemplateStage[]> {
  let raw: string;
  try {
    raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  } catch {
    fail(`Could not read ${path === "-" ? "stdin" : path}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${path === "-" ? "stdin" : path} is not JSON.`);
  }

  // A bare array, or `{ "stages": [...] }` — which is what `supi board <id>` prints, so the
  // output of one command is the input of another without a jq in between.
  const stages = Array.isArray(parsed) ? parsed : (parsed as { stages?: unknown })?.stages;
  if (!Array.isArray(stages) || stages.length === 0) {
    fail(
      "Expected a non-empty array of stages, or an object with a `stages` array.",
      "  supi board <boardId> | supi create-board 'Copy' --stages -",
    );
  }
  if (!stages.every((s) => s && typeof s === "object" && typeof (s as { key?: unknown }).key === "string")) {
    fail("Every stage needs a string `key`.");
  }
  return stages as BoardTemplateStage[];
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const json = wantsJson(rest);
  wantJson = json;
  // Flags and the values they consume removed — see `positionals`; the old filter kept the value.
  const pos = positionals(rest);

  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(USAGE + "\n");
      return;

    case "version":
      process.stdout.write(`supi ${VERSION} ${process.platform}/${process.arch}\n`);
      return;

    case "update": {
      // The network work lives in update.ts; this only decides what to print. A failure throws
      // with a message written to be shown as it stands, so it is not re-worded here.
      try {
        process.stdout.write((await runUpdate({ check: rest.includes("--check") })) + "\n");
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    case "whoami": {
      const c = await credentialOrExit();
      const described = describeCredential(c);
      if (!described) fail("The stored credential is not a token this can read.");
      if (json) {
        out({ ...described, superpipeline: baseUrl() });
        return;
      }
      process.stdout.write(
        // An agent token carries no principal id — it is an opaque secret, and the agent it names
        // lives in superpipeline's catalog. Saying so beats printing an empty field.
        `principal  ${described.principal ?? "(not carried by an agent token)"}\n` +
          `kind       ${described.kind}\n` +
          `superpipeline   ${baseUrl()}\n` +
          `token from ${c.source}\n` +
          (described.expires ? `expires    ${new Date(described.expires).toLocaleString()}\n` : ""),
      );
      return;
    }

    case "boards":
      out(await api("/v1/boards"), renderBoards);
      return;

    case "board": {
      if (!pos[0]) fail("usage: supi board <boardId>");
      out(await api(`/v1/boards/${pos[0]}`), renderBoard);
      return;
    }

    case "card": {
      if (!pos[0] || !pos[1]) fail("usage: supi card <boardId> <cardId>");
      out(await api(`/v1/boards/${pos[0]}/cards/${pos[1]}`));
      return;
    }

    case "move": {
      if (!pos[0] || !pos[1] || !pos[2]) fail("usage: supi move <boardId> <cardId> <stageKey>");
      out(
        await api(`/v1/boards/${pos[0]}/cards/${pos[1]}/move`, {
          method: "POST",
          body: JSON.stringify({ toStageKey: pos[2] }),
        }),
      );
      return;
    }

    case "gates": {
      if (!pos[0]) fail("usage: supi gates <boardId>");
      out(await api(`/v1/boards/${pos[0]}/gates/pending`), renderGates);
      return;
    }

    /**
     * Deciding a gate, from the place the work is already being watched.
     *
     * `gates` could list what was waiting and nothing could answer it: the resolve route existed
     * with no verb in front of it, so a human at a terminal had to open the web app or a phone to
     * say yes to work they were already looking at.
     *
     * Three verbs rather than `supi gate <id> <decision>` because the decision is the point of the
     * command and belongs where it can be read: `supi reject` mistyped is a usage error, while
     * `supi gate … reject` mistyped is a different decision.
     */
    case "approve":
    case "reject":
    case "request-changes": {
      if (!pos[0] || !pos[1]) fail(`usage: supi ${cmd} <boardId> <gateId> [--comment "why"]`);
      const comment = flag(rest, "--comment") ?? undefined;
      // `request_changes` returns the card for rework, and the feedback IS the rework instruction —
      // superpipeline merges it into the handoff the next run reads. Sending one without a comment
      // re-queues the work with nothing said about what was wrong.
      if (cmd === "request-changes" && !comment) {
        fail("request-changes needs a reason.", '  supi request-changes <boardId> <gateId> --comment "what to change"');
      }
      const decision = cmd === "request-changes" ? "request_changes" : cmd;
      out(
        await api(`/v1/boards/${pos[0]}/gates/${pos[1]}/resolve`, {
          method: "POST",
          body: JSON.stringify({ decision, ...(comment ? { comment } : {}) }),
        }),
      );
      return;
    }

    /**
     * What an agent actually did on a card.
     *
     * `GET /cards/:cardId/activities` has always returned the transcript, the handoff and the
     * card's gates, and nothing put it in reach: reading one meant a hand-built curl with a token
     * lifted out of the credential file.
     */
    case "log": {
      if (!pos[0] || !pos[1]) fail("usage: supi log <boardId> <cardId>");
      out(await api(`/v1/boards/${pos[0]}/cards/${pos[1]}/activities`), renderLog);
      return;
    }

    /**
     * Archive a card. Phase 1 shipped the `archivedAt` column and the "show archived" filter with
     * no way to ever produce an archived card — a filter for a state nothing could reach. This,
     * and the drawer's own Archive action (Task 17b), are that write. Both send `archivedAt`
     * through the same `PATCH /cards/:cardId` the rest of this file already uses, so there is one
     * server-side rule (`isInvalidDueAt`'s sibling check, `index.ts` ~1345) rather than two.
     */
    case "archive": {
      if (!pos[0] || !pos[1]) fail("usage: supi archive <boardId> <cardId>");
      out(
        await api(`/v1/boards/${pos[0]}/cards/${pos[1]}`, {
          method: "PATCH",
          body: JSON.stringify({ archivedAt: new Date().toISOString() }),
        }),
      );
      return;
    }

    /**
     * Dependencies and sub-task containment (spec §3.4) — the CLI's client for Task 17a's link
     * routes (`POST|DELETE /v1/boards/:id/links`, `GET .../cards/:cardId/links`), which Task 12
     * built on the Durable Object and Task 17a finally gave a wire.
     *
     * `--kind` is validated here, not sent and refused: the route already checks it and answers
     * 400 for anything else, but a client that let the server catch its own typo would show a
     * generic "invalid kind" instead of naming the three values that are actually accepted.
     *
     * `--to-board` is Task 17d: the same route now also carries Task 16's cross-board advisory
     * edges when it names a board other than the path's own. **The notice below is the point of
     * this flag, not a nice-to-have.** A cross-board edge is stored but never enforced — nothing
     * on the claim path ever reads it — so a person who asks for a blocker across boards and gets
     * one that silently refuses nothing has been misled the moment the badge is the first they
     * hear of it. The CLI has no server round trip to wait on to know this: `toBoardId` vs the
     * path `boardId` is the same string comparison the route itself makes, so it is printed BEFORE
     * the request is sent, not parsed out of the response after. A prompt-for-confirmation was
     * the other option; this is a non-interactive tool run from scripts as often as a terminal, so
     * a printed warning that can't hang on absent stdin was preferred over one that can.
     */
    case "link": {
      const LINK_KINDS = ["blocks", "relates", "parent"] as const;
      const sub = pos[0];

      if (sub === "add" || sub === "rm") {
        const boardId = pos[1];
        const fromCardId = pos[2];
        const toCardId = pos[3];
        const usage = `usage: supi link ${sub} <boardId> <fromCardId> <toCardId> --kind blocks|relates|parent [--to-board <boardId>]`;
        if (!boardId || !fromCardId || !toCardId) fail(usage);
        const kind = flag(rest, "--kind");
        if (!kind || !(LINK_KINDS as readonly string[]).includes(kind)) {
          fail(`--kind must be one of ${LINK_KINDS.join(", ")}${kind ? `, got "${kind}"` : ""}.`, usage);
        }
        const toBoardId = flag(rest, "--to-board");
        if (sub === "add" && toBoardId && toBoardId !== boardId) {
          process.stdout.write(
            `Note: ${toBoardId} is a different board, so this edge will be ADVISORY ONLY — shown, but ` +
              `not enforced. A card on another board cannot be read on this board's claim path, so this ` +
              `will not block anything from being claimed. Only a same-board blocker does that.\n`,
          );
        }
        out(
          await api(`/v1/boards/${boardId}/links`, {
            method: sub === "add" ? "POST" : "DELETE",
            body: JSON.stringify(toBoardId ? { fromCardId, toCardId, kind, toBoardId } : { fromCardId, toCardId, kind }),
          }),
        );
        return;
      }

      if (sub === "list") {
        const boardId = pos[1];
        const cardId = pos[2];
        if (!boardId || !cardId) fail("usage: supi link list <boardId> <cardId>");
        out(await api(`/v1/boards/${boardId}/cards/${cardId}/links`));
        return;
      }

      fail(
        "usage: supi link add <boardId> <fromCardId> <toCardId> --kind blocks|relates|parent [--to-board <boardId>]\n" +
          "  supi link rm <boardId> <fromCardId> <toCardId> --kind blocks|relates|parent [--to-board <boardId>]\n" +
          "  supi link list <boardId> <cardId>",
      );
    }

    // The two sides of the routing comparison, and the edges between them.
    //
    // Routing is exact string equality between a stage's `owner` and an agent's EFFECTIVE
    // capability set — the closure of what it declares over the implication edges. So when a card
    // will not move, the entire diagnosis is that comparison, and these are how it is read without
    // opening the web app. A lane whose capability nobody holds is a real state rather than an
    // error, which is exactly why it has to be visible.
    case "set-stages": {
      if (!pos[0] || !pos[1]) fail("usage: supi set-stages <boardId> <file|->");
      // Same `--stages` shape `create-board` accepts, so a pipeline can be read back with
      // `supi board <id> --json`, edited, and put straight back.
      out(await api(`/v1/boards/${pos[0]}/stages`, {
        method: "PUT",
        body: JSON.stringify({ stages: await stagesFromFile(pos[1]) }),
      }));
      return;
    }

    /**
     * One stage, without holding the rest of the pipeline.
     *
     * `set-stages` replaces every stage, so setting one rule meant reading them all, editing a
     * JSON file by hand and putting them all back — four times in one afternoon on one board, and
     * every one of those writes would have discarded a concurrent edit to a stage it never
     * touched.
     *
     * `--instructions` reads a FILE or stdin rather than taking a string, because a stage rule is
     * paragraphs with line breaks and shell quoting mangles those in ways that are invisible
     * until an agent reads them.
     */
    case "set-stage": {
      if (!pos[0] || !pos[1]) {
        fail(
          "usage: supi set-stage <boardId> <stageKey> [--instructions <file|->] [--name <name>]",
          "  [--gate none|approval] [--wip <n>] [--owner <capability>] [--completion <file|->]\n" +
            "  [--clear-instructions] [--clear-completion]",
        );
      }
      const patch: Record<string, unknown> = {};
      const instructionsArg = flag(rest, "--instructions");
      if (instructionsArg) patch.instructions = readText(instructionsArg);
      /**
       * What a run must produce here before the board believes it finished.
       *
       * A file rather than a flag per arm: the requirement is a small structure — keys, a
       * reference shape — and spelling it as `--handoff url --handoff commit --ref-provider forge`
       * would invent a second grammar for something the API already has one for.
       */
      const completionArg = flag(rest, "--completion");
      if (completionArg) {
        const raw = readText(completionArg);
        try {
          patch.completion = JSON.parse(raw);
        } catch {
          fail(`${completionArg === "-" ? "stdin" : completionArg} is not JSON.`);
        }
      }
      if (rest.includes("--clear-completion")) patch.completion = null;
      // Explicit, and its own flag: `--instructions ""` cannot mean "remove" when an empty rule
      // is refused, and a flag that deletes something should have to be typed.
      if (rest.includes("--clear-instructions")) patch.instructions = null;
      const nameArg = flag(rest, "--name");
      if (nameArg) patch.name = nameArg;
      const gateArg = flag(rest, "--gate");
      if (gateArg) patch.gate = gateArg;
      const ownerArg = flag(rest, "--owner");
      if (ownerArg) patch.owner = ownerArg;
      const wipArg = flag(rest, "--wip");
      if (wipArg) patch.wipLimit = wipArg === "none" ? null : Number(wipArg);

      if (Object.keys(patch).length === 0) {
        fail("Nothing to change.", "  supi set-stage <boardId> <stageKey> --instructions <file|->");
      }
      out(await api(`/v1/boards/${pos[0]}/stages/${pos[1]}`, { method: "PATCH", body: JSON.stringify(patch) }));
      return;
    }

    case "create-card": {
      if (!pos[0] || !pos[1]) {
        fail(
          "usage: supi create-card <boardId> <title> [--spec <file|->] [--priority <n>]",
          "  [--due YYYY-MM-DD] [--label <id>]...",
        );
      }
      const specArg = flag(rest, "--spec");
      const priorityArg = flag(rest, "--priority");
      const dueArg = flag(rest, "--due");
      // Repeatable — a card can carry more than one label at creation.
      const labelIds = flags(rest, "--label");
      // Every remaining positional is the title, so a sentence needs no quoting.
      const body: Record<string, unknown> = { title: pos.slice(1).join(" ") };
      if (specArg) {
        const raw = specArg === "-" ? readFileSync(0, "utf8") : readFileSync(specArg, "utf8");
        try {
          body.spec = JSON.parse(raw);
        } catch {
          fail(`--spec is not JSON: ${specArg}`);
        }
      }
      if (priorityArg) body.priority = Number(priorityArg);
      if (dueArg) {
        // Checked here, not sent and refused: `POST /cards` answers a malformed `dueAt` with a
        // 400 whose sentence is about a field named `dueAt`, not the flag the person typed.
        if (!DUE_AT_RE.test(dueArg)) {
          fail(`--due is not a date in YYYY-MM-DD form: ${dueArg}`);
        }
        body.dueAt = dueArg;
      }
      const created = (await api(`/v1/boards/${pos[0]}/cards`, {
        method: "POST",
        body: JSON.stringify(body),
      })) as { card: { id: string } };
      // Labels are not part of `POST /cards` — applied with a follow-up PATCH against the same
      // route the drawer and `supi move` already use, hitting the label-id validation there
      // (`unknownLabelIds`) rather than duplicating it here.
      if (labelIds.length > 0) {
        out(
          await api(`/v1/boards/${pos[0]}/cards/${created.card.id}`, {
            method: "PATCH",
            body: JSON.stringify({ labels: labelIds }),
          }),
        );
        return;
      }
      out(created);
      return;
    }

    /**
     * Where this workspace's forge is, so references from it are recognised.
     *
     * GitHub needs no configuration — there is one github.com. A Forgejo instance is at whatever
     * host its operator chose, so recognition has to be told, and until it is, every link to the
     * workspace's own repositories is stored as a generic `url`: no durable id, nothing to dedupe
     * against, nothing a webhook could ever match.
     */
    case "forge": {
      if (!pos[0]) {
        const t = (await api("/v1/tenant/forge")) as { forgeHost?: string | null };
        const host = t.forgeHost ?? null;
        out({ forgeHost: host }, () =>
          host ? `forge  ${host}` : "No forge configured. `supi forge <host>` sets one.",
        );
        return;
      }
      const host = pos[0] === "none" ? null : pos[0];
      await api("/v1/tenant/forge", { method: "PUT", body: JSON.stringify({ forgeHost: host }) });
      out({ forgeHost: host }, () => (host ? `forge  ${host}` : "Forge cleared."));
      return;
    }

    case "agents":
      out(await api("/v1/agents"));
      return;

    /**
     * What bounds an agent that queues work of its own (superpipeline migration 0015).
     *
     * A separate verb from `agents` because it WRITES, and the three fields it writes are the whole
     * blast radius of a coordinator: without them the policy could only be set by opening a
     * database, which is both unauditable and the kind of manual step this CLI exists to remove.
     *
     * The dispatch grant is deliberately NOT here. It lives in AgentPod — `fleet grants set` — and
     * reaches superpipeline in the token's claims, so a copy here would keep authorising dispatches
     * after the operator revoked them.
     */
    case "agent": {
      if (pos[0] !== "queueing" || !pos[1]) {
        fail("usage: supi agent queueing <agentId> [--owner <userId>|none] [--boards <id,id>|none] [--ceiling <n>]");
      }
      const body: Record<string, unknown> = {};
      const owner = flag(rest, "--owner");
      // `none` rather than an empty value, so clearing is something the caller TYPED. `flag` returns
      // null both for "absent" and for "present with no value", so a bare `--owner` must not be read
      // as "clear the owner" — that would make a typo into a revocation.
      if (owner !== null) body.ownerUserId = owner === "none" ? null : owner;
      const boards = flag(rest, "--boards");
      if (boards !== null) {
        body.mayQueueTo =
          boards === "none" ? null : boards.split(",").map((b) => b.trim()).filter((b) => b !== "");
      }
      const ceiling = flag(rest, "--ceiling");
      if (ceiling !== null) {
        const n = Number(ceiling);
        if (!Number.isInteger(n) || n < 1) fail("--ceiling must be a whole number of at least 1");
        body.queueCeilingPerHour = n;
      }
      if (Object.keys(body).length === 0) fail("nothing to change: pass --owner, --boards or --ceiling");
      out(await api(`/v1/agents/${pos[1]}`, { method: "PATCH", body: JSON.stringify(body) }));
      return;
    }

    case "capabilities":
      out(await api("/v1/capabilities"));
      return;

    case "implications":
      out(await api("/v1/capabilities/implications"));
      return;

    /**
     * The tenant's label catalogue (Task 4's `/v1/labels[/:id]`) — the same one
     * `resolveLabelNames` resolves a card's typed names against, so a person can see what already
     * exists, or declare one deliberately instead of leaving it to be inferred from what they type
     * into a card.
     */
    case "label": {
      const sub = pos[0];
      if (sub === "list") {
        out(await api("/v1/labels"));
        return;
      }
      if (sub === "add") {
        const name = pos[1];
        const colour = pos[2];
        if (!name || !colour) fail("usage: supi label add <name> <colour>");
        out(await api("/v1/labels", { method: "POST", body: JSON.stringify({ name, colour }) }));
        return;
      }
      if (sub === "rm") {
        const id = pos[1];
        if (!id) fail("usage: supi label rm <id>");
        await api(`/v1/labels/${id}`, { method: "DELETE" });
        out({ deleted: id }, () => `Deleted ${id}.`);
        return;
      }
      fail("usage: supi label list | supi label add <name> <colour> | supi label rm <id>");
    }

    /**
     * Projects and milestones (Task 18's `/v1/projects[/:id[/milestones]]`,
     * `/v1/milestones/:id`) — a project groups cards ACROSS boards, the same way a label does,
     * and until this had no CLI client either. `supi project set`/health editing is not here:
     * this task is `list|add|show|rm` only, matching the brief.
     *
     * `--target` is checked client-side against the same shape the API enforces (`DUE_AT_RE`,
     * `isInvalidDueAt` in `apps/api/src/index.ts`) before anything is sent — same reasoning as
     * `create-card --due` above: a malformed date never leaves the terminal, so the person sees
     * this message rather than the server's generic one about a field named `targetDate`.
     */
    case "project": {
      const sub = pos[0];

      if (sub === "list") {
        out(await api("/v1/projects"), renderProjects);
        return;
      }

      if (sub === "add") {
        const name = pos[1];
        const usage = "usage: supi project add <name> [--description <text>] [--target YYYY-MM-DD] [--lead <userId>]";
        if (!name) fail(usage);
        const body: Record<string, unknown> = { name };
        const description = flag(rest, "--description");
        if (description) body.description = description;
        const target = flag(rest, "--target");
        if (target) {
          if (!DUE_AT_RE.test(target)) fail(`--target is not a date in YYYY-MM-DD form: ${target}`, usage);
          body.targetDate = target;
        }
        const lead = flag(rest, "--lead");
        if (lead) body.leadUserId = lead;
        out(await api("/v1/projects", { method: "POST", body: JSON.stringify(body) }));
        return;
      }

      if (sub === "show") {
        const projectId = pos[1];
        if (!projectId) fail("usage: supi project show <projectId>");
        out(await api(`/v1/projects/${projectId}`), renderProject);
        return;
      }

      if (sub === "rm") {
        const projectId = pos[1];
        if (!projectId) fail("usage: supi project rm <projectId>");
        await api(`/v1/projects/${projectId}`, { method: "DELETE" });
        out({ deleted: projectId }, () => `Deleted ${projectId}.`);
        return;
      }

      fail(
        "usage: supi project list\n" +
          "  supi project add <name> [--description <text>] [--target YYYY-MM-DD] [--lead <userId>]\n" +
          "  supi project show <projectId>\n" +
          "  supi project rm <projectId>",
      );
    }

    /**
     * One milestone inside one project, ordered within it by `sortOrder` (ascending, then name —
     * `db/projects.ts`'s `listMilestones`, what `supi project show` prints). `rm` goes through
     * `/v1/milestones/:id`, NOT the project's own route — a milestone is removed on its own
     * without deleting the project it belongs to.
     */
    case "milestone": {
      const sub = pos[0];

      if (sub === "add") {
        const projectId = pos[1];
        const name = pos[2];
        const usage = "usage: supi milestone add <projectId> <name> [--target YYYY-MM-DD] [--sort <n>]";
        if (!projectId || !name) fail(usage);
        const body: Record<string, unknown> = { name };
        const target = flag(rest, "--target");
        if (target) {
          if (!DUE_AT_RE.test(target)) fail(`--target is not a date in YYYY-MM-DD form: ${target}`, usage);
          body.targetDate = target;
        }
        const sortArg = flag(rest, "--sort");
        if (sortArg !== null) {
          const sortOrder = Number(sortArg);
          if (!Number.isFinite(sortOrder)) fail(`--sort must be a number, got "${sortArg}".`, usage);
          body.sortOrder = sortOrder;
        }
        out(await api(`/v1/projects/${projectId}/milestones`, { method: "POST", body: JSON.stringify(body) }));
        return;
      }

      if (sub === "rm") {
        const milestoneId = pos[1];
        if (!milestoneId) fail("usage: supi milestone rm <milestoneId>");
        await api(`/v1/milestones/${milestoneId}`, { method: "DELETE" });
        out({ deleted: milestoneId }, () => `Deleted ${milestoneId}.`);
        return;
      }

      fail(
        "usage: supi milestone add <projectId> <name> [--target YYYY-MM-DD] [--sort <n>]\n" +
          "  supi milestone rm <milestoneId>",
      );
    }

    /**
     * A recurring card, and the cadence that fires it (Task 8's rule grammar, Task 9's CRUD on the
     * DO, Task 10's route). `add` validates only the SHAPE of what it sends — required flags are
     * present and `--overlap`/`--priority` parse to the right type — never the rule's grammar: the
     * server owns that, and its own message (`INVALID_RULE`'s `error.message`, printed as `api()`
     * already prints any refusal) is the sentence that tells the author what to type instead. A
     * client that re-validated the grammar is a client that will one day disagree with the server
     * about what a valid rule is.
     */
    case "schedule": {
      const sub = pos[0];

      if (sub === "list") {
        const boardId = pos[1];
        if (!boardId) fail("usage: supi schedule list <boardId>");
        out(await api(`/v1/boards/${boardId}/schedules`));
        return;
      }

      if (sub === "add") {
        const boardId = pos[1];
        const usage =
          "usage: supi schedule add <boardId> --title <t> --rule <r> --tz <tz>\n" +
          "  [--stage <key>] [--priority <n>] [--overlap skip|allow]";
        if (!boardId) fail(usage);
        const title = flag(rest, "--title");
        const rule = flag(rest, "--rule");
        const tz = flag(rest, "--tz");
        if (!title || !rule || !tz) fail(usage);
        const body: Record<string, unknown> = { title, rule, timezone: tz };
        const stage = flag(rest, "--stage");
        if (stage) body.stageKey = stage;
        const priorityArg = flag(rest, "--priority");
        if (priorityArg) body.priority = Number(priorityArg);
        const overlapArg = flag(rest, "--overlap");
        if (overlapArg) {
          if (overlapArg !== "skip" && overlapArg !== "allow") {
            fail(`--overlap must be "skip" or "allow", not "${overlapArg}"`);
          }
          body.overlap = overlapArg;
        }
        out(await api(`/v1/boards/${boardId}/schedules`, { method: "POST", body: JSON.stringify(body) }));
        return;
      }

      if (sub === "rm") {
        const boardId = pos[1];
        const scheduleId = pos[2];
        if (!boardId || !scheduleId) fail("usage: supi schedule rm <boardId> <scheduleId>");
        await api(`/v1/boards/${boardId}/schedules/${scheduleId}`, { method: "DELETE" });
        out({ deleted: scheduleId }, () => `Deleted ${scheduleId}.`);
        return;
      }

      if (sub === "pause" || sub === "resume") {
        const boardId = pos[1];
        const scheduleId = pos[2];
        if (!boardId || !scheduleId) fail(`usage: supi schedule ${sub} <boardId> <scheduleId>`);
        out(
          await api(`/v1/boards/${boardId}/schedules/${scheduleId}`, {
            method: "PATCH",
            body: JSON.stringify({ enabled: sub === "resume" }),
          }),
        );
        return;
      }

      fail(
        "usage: supi schedule list <boardId>\n" +
          "  supi schedule add <boardId> --title <t> --rule <r> --tz <tz> [--stage <key>] [--priority <n>] [--overlap skip|allow]\n" +
          "  supi schedule rm <boardId> <scheduleId>\n" +
          "  supi schedule pause <boardId> <scheduleId>\n" +
          "  supi schedule resume <boardId> <scheduleId>",
      );
    }

    case "templates": {
      // No credential needed: these are shipped with the CLI, not fetched. Someone deciding
      // which template to use should not have to sign in first.
      out(
        BOARD_TEMPLATES.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          stages: t.stages.map((s) => s.key),
        })),
      );
      return;
    }

    case "create-board": {
      if (!pos[0]) fail("usage: supi create-board <name> [--template <id>] [--stages <file|->]");
      const name = pos[0];

      const stagesFlag = flag(rest, "--stages");
      const templateFlag = flag(rest, "--template");
      if (stagesFlag && templateFlag) {
        fail("--stages and --template both name the pipeline; pass one.");
      }

      const stages = stagesFlag ? await stagesFromFile(stagesFlag) : stagesFromTemplate(templateFlag ?? "simple");
      out(await api("/v1/boards", { method: "POST", body: JSON.stringify({ name, stages }) }));
      return;
    }

    default:
      fail(`unknown command: ${cmd}`, USAGE);
  }
}

await main(process.argv.slice(2));
