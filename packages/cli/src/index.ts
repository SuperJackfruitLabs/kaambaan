#!/usr/bin/env bun
/**
 * `kbn` — kaambaan from a terminal.
 *
 * The third consumer of `@kaambaan/contract`, after REST and MCP. It is a client: it adds no
 * authority, performs no local permission check, and renders the board's own refusals. A client
 * that pre-empts a server decision is a client that will one day disagree with it.
 *
 * The verbs here are **work** verbs, because a hub token resolves as a `member` — see README.md
 * for why that is a decision rather than a limitation, and what it would take to change.
 */
import { baseUrl, expired, inspect, loadCredential, ENV_TOKEN } from "./credential.ts";

const USAGE = `kbn — kaambaan from a terminal

  kbn whoami                  who the stored token says you are
  kbn boards                  the workspace's boards
  kbn board <boardId>         one board: its stages and their cards
  kbn card <boardId> <cardId> one card in full
  kbn move <boardId> <cardId> <stageKey>
                              move a card to another stage
  kbn gates <boardId>         approval gates waiting on a human

  --json                      machine-stable output, on any command

Credential: $${ENV_TOKEN}, else $AGENTPOD_TOKEN, else the token \`apn fleet login\` writes.
One sign-in serves both planes — kaambaan verifies the hub's token offline.

Not here: creating boards, staffing agents, editing capabilities, changing the fleet link.
Those need a seat in the workspace, which a hub token does not grant. See README.md.`;

function wantsJson(args: string[]): boolean {
  return args.includes("--json");
}

function fail(message: string, hint?: string): never {
  process.stderr.write(message + "\n");
  if (hint) process.stderr.write("\n" + hint + "\n");
  process.exit(1);
}

function credentialOrExit() {
  const c = loadCredential();
  if (!c) {
    fail(
      "Not signed in.",
      `  apn fleet login          sign in once, for both planes\n` +
        `  ${ENV_TOKEN}=…   supply a token directly`,
    );
  }
  const claims = inspect(c.token);
  if (claims && expired(claims)) {
    fail(`Your session expired at ${claims.expiry!.toLocaleString()}.`, "  apn fleet login");
  }
  return c;
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const c = credentialOrExit();
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
    fail("kaambaan did not accept that token (401).", "  apn fleet login");
  }
  if (res.status === 403) {
    // Distinguished from 401 deliberately: 401 means sign in, 403 means you may not. A hub token
    // is a `member`, so a management verb lands here — and telling a person to sign in again
    // when the answer is "your seat does not permit this" sends them round a loop.
    fail(
      `Refused by kaambaan (403). ${body.trim()}`,
      "A hub token acts as a `member`. Managing boards, agents or people needs a seat in the\n" +
        "workspace — see packages/cli/README.md.",
    );
  }
  if (!res.ok) fail(`kaambaan returned ${res.status}: ${body.trim()}`);

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

const out = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const json = wantsJson(rest);
  const pos = rest.filter((a) => !a.startsWith("--"));

  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(USAGE + "\n");
      return;

    case "whoami": {
      const c = credentialOrExit();
      const claims = inspect(c.token);
      if (!claims) fail("The stored credential is not a token this can read.");
      if (json) {
        out({
          principal: claims.subject,
          kind: claims.principalKind,
          source: c.source,
          kaambaan: baseUrl(),
          expires: claims.expiry?.toISOString() ?? null,
        });
        return;
      }
      process.stdout.write(
        `principal  ${claims.subject}\n` +
          `kind       ${claims.principalKind}\n` +
          `kaambaan   ${baseUrl()}\n` +
          `token from ${c.source}\n` +
          (claims.expiry ? `expires    ${claims.expiry.toLocaleString()}\n` : ""),
      );
      return;
    }

    case "boards":
      out(await api("/v1/boards"));
      return;

    case "board": {
      if (!pos[0]) fail("usage: kbn board <boardId>");
      out(await api(`/v1/boards/${pos[0]}`));
      return;
    }

    case "card": {
      if (!pos[0] || !pos[1]) fail("usage: kbn card <boardId> <cardId>");
      out(await api(`/v1/boards/${pos[0]}/cards/${pos[1]}`));
      return;
    }

    case "move": {
      if (!pos[0] || !pos[1] || !pos[2]) fail("usage: kbn move <boardId> <cardId> <stageKey>");
      out(
        await api(`/v1/boards/${pos[0]}/cards/${pos[1]}/move`, {
          method: "POST",
          body: JSON.stringify({ toStageKey: pos[2] }),
        }),
      );
      return;
    }

    case "gates": {
      if (!pos[0]) fail("usage: kbn gates <boardId>");
      out(await api(`/v1/boards/${pos[0]}/gates/pending`));
      return;
    }

    default:
      fail(`unknown command: ${cmd}`, USAGE);
  }
}

await main(process.argv.slice(2));
