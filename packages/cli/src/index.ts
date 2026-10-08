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
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BOARD_TEMPLATES, boardTemplate, capabilityTag, type BoardTemplateStage } from "@superpipeline/contract";
import { baseUrl, clearSupiCredentials, describeCredential, expired, inspect, refusalHint, resolveCredential, saveSupiDevice, ENV_AGENT_TOKEN, ENV_AGENT_TOKEN_FILE, ENV_TOKEN } from "./credential.ts";
import { deviceLogin, discoverPlane, exchangeDevice } from "./plane-login.ts";
import { renderBoards, renderBoard, renderComments, renderGates, renderLog, renderProjects, renderProject } from "./render.ts";
import { flag, flags, isPlainObject, mergeSpec, positionals } from "./args.ts";
import { VERSION, runUpdate } from "./update.ts";
import { findCommands, renderCommandHelp, renderUsage } from "./commands.ts";

/**
 * The summary `supi help` prints, rendered from `commands.ts` — the same table the published
 * reference is generated from, so the help, the reference and this switch are held to one list
 * (`reference.test.ts`).
 */
const USAGE = renderUsage();

/** `supi help <verb> [<sub-verb>]` and `supi <verb> --help`: one command, or a verb's sub-commands, in full. */
function printHelp(words: string[]): void {
  const found = findCommands(words);
  if (found.length === 0) fail(`unknown command: ${words.join(" ")}`, "  supi help           every command");
  process.stdout.write(found.map(renderCommandHelp).join("\n\n") + "\n");
}

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
      `  supi login           sign in to this workspace\n` +
        `  fleet login          the sign-in for a server not yet on the organization plane\n` +
        `  ${ENV_TOKEN}=…   supply a token directly\n` +
        `  ${ENV_AGENT_TOKEN}=spa_…   act as an agent, not as a person\n` +
        `  ${ENV_AGENT_TOKEN_FILE}=…   a file something keeps fresh (a station token lives minutes)`,
    );
  }
  /**
   * An agent credential, and whether it has already died.
   *
   * An `spa_` token is opaque: no claims, no expiry, nothing to check. A STATION token is a JWT that
   * lives five minutes — "the expiry IS the revocation SLA" — so an expired one is the ordinary
   * symptom of a refresher that has stopped, and it must read as that rather than as a 401 from the
   * far end. The remedy is never "sign in": an agent cannot.
   */
  if (c.kind === "agent") {
    const agentClaims = inspect(c.token);
    if (agentClaims && expired(agentClaims)) {
      fail(
        `This agent token expired at ${agentClaims.expiry!.toLocaleString()}.`,
        c.source.startsWith("file:")
          ? `  Nothing refreshed ${c.source.slice(5)} — check the node-agent on this host.`
          : `  A station token lives minutes. Point ${ENV_AGENT_TOKEN_FILE} at a file something keeps fresh.`,
      );
    }
    return c;
  }
  const claims = inspect(c.token);
  if (claims && expired(claims)) {
    const hint = c.source.startsWith("env:")
      ? `Replace or unset ${c.source.slice(4)}; explicit tokens are not renewed.`
      : "supi login   (fleet login, for a server not yet on the organization plane)";
    fail(`Your session expired at ${claims.expiry!.toLocaleString()}.`, `  ${hint}`);
  }
  return c;
}

/**
 * `conflict`, when given, is the sentence a 409 prints instead of the generic "returned 409" — for
 * a request that carried a precondition, where 409 means exactly one thing and the person should
 * be told what it was.
 */
async function api(path: string, init: RequestInit = {}, opts: { conflict?: string } = {}): Promise<unknown> {
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
    fail("superpipeline did not accept that token (401).", "  supi login   (fleet login, for a server not yet on the organization plane)");
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
    // Which dead end this is depends on what is holding the credential — see `refusalHint`.
    fail(`Refused by superpipeline (403). ${body.trim()}`, refusalHint(c.kind));
  }
  if (res.status === 409 && opts.conflict) fail(opts.conflict);
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

/** A JSON value from a file, or stdin for `-`; refused by the flag's name when it is not JSON. */
function readJson(path: string, flagName: string): unknown {
  let raw: string;
  try {
    raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  } catch {
    fail(`Could not read ${path === "-" ? "stdin" : path}.`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${flagName} is not JSON: ${path}`);
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

/** What each `mint-token --kind` asks the server for. The scope names are the contract's. */
const TOKEN_KINDS: Record<string, string[]> = {
  "claim-run": ["claim", "run"],
  "run-only": ["run"],
};

/** The shape the server checks too (`apps/api` POST /v1/agents); caught here so a typo never leaves the terminal. */
const PRINCIPAL_RE = /^prn_[0-9a-f]{20}$/;

/**
 * Write a secret to `path`, readable by its owner only.
 *
 * Written to a sibling temporary file created 0600 and renamed over the target, so the secret is
 * never — even for an instant — in a file with wider permissions: `writeFileSync`'s `mode` applies
 * only when it CREATES a file, and an existing 0644 file would otherwise keep its mode. The chmod
 * is belt and braces against a umask that strips owner bits.
 */
function writeSecret(path: string, secret: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, secret + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    fail(`Could not write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const json = wantsJson(rest);
  wantJson = json;
  // Flags and the values they consume removed — see `positionals`; the old filter kept the value.
  const pos = positionals(rest);

  // `supi <verb> --help` explains the verb instead of running it — a person checking what
  // `set-stages` does should not have replaced a pipeline to find out.
  if (cmd !== undefined && cmd !== "help" && rest.includes("--help")) {
    printHelp([cmd, ...pos]);
    return;
  }

  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
      process.stdout.write(USAGE + "\n");
      return;

    case "help":
      if (pos.length > 0) printHelp(pos);
      else process.stdout.write(USAGE + "\n");
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

    case "login": {
      const target = await discoverPlane(baseUrl()).catch(() => null);
      if (!target) fail(`${baseUrl()} does not sign in through an organization plane yet.`, "  fleet login          the sign-in it uses today");
      const credential = await deviceLogin(target, {
        print: (l) => process.stdout.write(l + "\n"),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      }).catch((e) => fail(e instanceof Error ? e.message : String(e)));
      saveSupiDevice({ credential, plane: target.plane, audience: target.audience });
      await exchangeDevice(target, credential).catch((e) => fail(e instanceof Error ? e.message : String(e)));
      process.stdout.write("Signed in.\n");
      return;
    }
    case "logout":
      clearSupiCredentials();
      process.stdout.write("Signed out on this machine.\n");
      return;

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
     * A card's comment thread: `comment` adds to it, `comments` reads it.
     *
     * The body is every remaining word, like `create-card`'s title, or stdin for `-` — so a
     * multi-line note, a list or a pasted log goes in as written. Who may post is the server's
     * call: a person with board read access, or the agent whose live run holds this card.
     */
    case "comment": {
      if (!pos[0] || !pos[1]) fail("usage: supi comment <boardId> <cardId> <text|->");
      const text = pos[2] === "-" && pos.length === 3 ? readText("-") : pos.slice(2).join(" ").trim();
      if (!text) fail("Nothing to say.", "  supi comment <boardId> <cardId> <text>   (or - to read it from stdin)");
      out(
        await api(`/v1/boards/${pos[0]}/cards/${pos[1]}/comments`, { method: "POST", body: JSON.stringify({ body: text }) }),
      );
      return;
    }

    case "comments": {
      if (!pos[0] || !pos[1]) fail("usage: supi comments <boardId> <cardId>");
      out(await api(`/v1/boards/${pos[0]}/cards/${pos[1]}/comments`), renderComments);
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
     * Edit a card's title, spec, priority or due date — the PATCH the web drawer sends.
     *
     * `--spec` replaces the spec whole. `--merge-spec` is a read-modify-write: read the card, merge
     * the given object one level deep (a top-level `null` removes that key), and write back with
     * `expectedUpdatedAt` set to what was read — so an edit someone made in between is refused
     * with a 409 rather than silently overwritten by a spec built from the older copy.
     */
    case "edit-card": {
      if (!pos[0] || !pos[1]) {
        fail(
          "usage: supi edit-card <boardId> <cardId> [--title <text>] [--spec <file|->]",
          "  [--merge-spec <file|->] [--priority <n>] [--due YYYY-MM-DD|none]",
        );
      }
      const titleArg = flag(rest, "--title");
      const specArg = flag(rest, "--spec");
      const mergeArg = flag(rest, "--merge-spec");
      const priorityArg = flag(rest, "--priority");
      const dueArg = flag(rest, "--due");
      if (specArg && mergeArg) fail("--spec replaces the spec and --merge-spec merges into it; pass one.");
      if (!titleArg && !specArg && !mergeArg && !priorityArg && !dueArg) {
        fail("Nothing to change.", "  supi edit-card <boardId> <cardId> --title … | --spec … | --merge-spec … | --priority … | --due …");
      }
      const body: Record<string, unknown> = {};
      if (titleArg) body.title = titleArg;
      if (priorityArg) {
        const n = Number(priorityArg);
        if (!Number.isFinite(n)) fail(`--priority is not a number: ${priorityArg}`);
        body.priority = n;
      }
      if (dueArg) {
        if (dueArg !== "none" && !DUE_AT_RE.test(dueArg)) fail(`--due is not a date in YYYY-MM-DD form, or \`none\`: ${dueArg}`);
        body.dueAt = dueArg === "none" ? null : dueArg;
      }
      if (specArg) body.spec = readJson(specArg, "--spec");
      const cardPath = `/v1/boards/${pos[0]}/cards/${pos[1]}`;
      if (mergeArg) {
        const merge = readJson(mergeArg, "--merge-spec");
        if (!isPlainObject(merge)) fail("--merge-spec must be a JSON object: its top-level keys are merged into the spec.");
        const { card } = (await api(cardPath)) as { card: { spec: unknown; updatedAt: string | null } };
        const current = card.spec ?? {};
        if (!isPlainObject(current)) {
          fail("This card's spec is not a JSON object, so there is nothing to merge into.", "  supi edit-card <boardId> <cardId> --spec <file|->   replace it instead");
        }
        body.spec = mergeSpec(current, merge);
        body.expectedUpdatedAt = card.updatedAt;
      }
      out(
        await api(cardPath, { method: "PATCH", body: JSON.stringify(body) }, {
          conflict:
            "The card changed since it was read, so the merge was refused. Nothing was written.\n\n" +
            "  Run the same command again: it re-reads the card and merges into what is there now.",
        }),
      );
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
      const sub = pos[0];

      /**
       * Create an agent, linked to the principal it IS as it is made.
       *
       * `--external-id` is required here, not optional as it is on the route: an agent created
       * without one is minted an `spa_` in the same response, and this verb exists to register an
       * agent that authenticates with its own org-plane tokens. A credential nobody asked for is
       * one more secret to leak; `mint-token` is the way to ask for one.
       */
      if (sub === "create") {
        const name = flag(rest, "--name");
        if (!name || name.trim() === "") fail("--name is required");
        const capabilities = flags(rest, "--capability")
          .flatMap((c) => c.split(","))
          .map((c) => c.trim())
          .filter((c) => c !== "");
        if (capabilities.length === 0) fail("at least one --capability is required");
        const externalId = flag(rest, "--external-id");
        if (!externalId) fail("--external-id is required: the agent's principal, as prn_…");
        if (!PRINCIPAL_RE.test(externalId)) fail("--external-id must look like prn_ followed by 20 lowercase hex characters");
        const body: Record<string, unknown> = { name: name.trim(), capabilities, externalId };
        const concurrency = flag(rest, "--concurrency");
        if (concurrency !== null) {
          const n = Number(concurrency);
          if (!Number.isInteger(n) || n < 1) fail("--concurrency must be a whole number of at least 1");
          body.concurrency = n;
        }
        out(await api("/v1/agents", { method: "POST", body: JSON.stringify(body) }));
        return;
      }

      /**
       * Mint a credential for an agent. The secret is shown ONCE — only its hash is kept — so where
       * it goes is the whole design:
       *
       *   - no `--out`: the token alone on stdout, everything else on stderr, so a redirect captures
       *     the secret and nothing more;
       *   - `--out FILE`: written 0600, and printed nowhere;
       *   - `--json`: one object whose `token` field is the only place the secret appears — absent
       *     entirely when `--out` took it.
       *
       * Nothing here logs it. The server decides who may: a person with `admin` or above, never an
       * agent, whatever it holds.
       */
      if (sub === "mint-token") {
        const agentId = pos[1];
        if (!agentId) fail("usage: supi agent mint-token <agentId> --kind claim-run|run-only [--out FILE]");
        const kind = flag(rest, "--kind");
        if (!kind || !(kind in TOKEN_KINDS)) fail("--kind must be claim-run or run-only");
        const target = flag(rest, "--out");
        const minted = (await api(`/v1/agents/${agentId}/tokens`, {
          method: "POST",
          body: JSON.stringify({ scopes: TOKEN_KINDS[kind] }),
        })) as { token?: unknown; tokenId?: unknown; scopes?: unknown };
        if (typeof minted?.token !== "string") fail("superpipeline answered without a token; nothing was minted that this can show.");
        const meta = { agentId, kind, tokenId: minted.tokenId, scopes: minted.scopes };
        if (target) {
          writeSecret(target, minted.token);
          if (wantJson) process.stdout.write(JSON.stringify({ ...meta, out: target }, null, 2) + "\n");
          else process.stdout.write(`Wrote ${kind} token ${String(minted.tokenId)} for ${agentId} to ${target} (mode 0600).\n`);
          return;
        }
        if (wantJson) {
          process.stdout.write(JSON.stringify({ ...meta, token: minted.token }, null, 2) + "\n");
          return;
        }
        process.stderr.write(
          `${kind} token ${String(minted.tokenId)} for ${agentId} (scopes: ${(minted.scopes as string[] | undefined)?.join(", ") ?? "?"}).\n` +
            "Shown once — store it now, readable only by you (0600). Revoke it in Workspace -> Agents.\n",
        );
        process.stdout.write(minted.token + "\n");
        return;
      }

      if (sub !== "queueing" || !pos[1]) {
        fail(
          "usage: supi agent create --name <name> --capability <key>... --external-id prn_… [--concurrency <n>]\n" +
            "       supi agent mint-token <agentId> --kind claim-run|run-only [--out FILE]\n" +
            "       supi agent queueing <agentId> [--owner <userId>|none] [--boards <id,id>|none] [--ceiling <n>]",
        );
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

    /**
     * Say what a capability MEANS — the registry's description — from a terminal.
     *
     * Takes the capability's id (`cap_…`) or its key, in any spelling a stage would normalise to
     * the same key. A key the registry has not heard of is declared with the definition, so an
     * operator can define the vocabulary before any agent or stage names it.
     */
    case "capability": {
      const sub = pos[0];
      const target = pos[1];
      if (sub !== "define" || !target) fail("usage: supi capability define <id|key> --definition <text>");
      const definition = flag(rest, "--definition");
      if (!definition || definition.trim() === "") fail("--definition is required: what holding this capability means");
      const description = definition.trim();
      let id: string | null = target.startsWith("cap_") ? target : null;
      if (!id) {
        const key = capabilityTag(target);
        if (key === "") fail(`${target} is not a capability key: it needs a letter or a digit`);
        const { capabilities } = (await api("/v1/capabilities")) as { capabilities?: Array<{ id: string; key: string }> };
        const found = (capabilities ?? []).find((c) => c.key === key);
        if (!found) {
          out(await api("/v1/capabilities", { method: "POST", body: JSON.stringify({ key, description }) }));
          return;
        }
        id = found.id;
      }
      out(await api(`/v1/capabilities/${id}`, { method: "PATCH", body: JSON.stringify({ description }) }));
      return;
    }

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
