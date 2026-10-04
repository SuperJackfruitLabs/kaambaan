# `supi` — superpipeline from a terminal

Installed as both `superpipeline` and `supi`; they are the same program. Examples use the short name.

## Installing

```sh
packages/cli/install.sh          # both names into ~/.local/bin
BIN_DIR=~/bin packages/cli/install.sh
packages/cli/install.sh --uninstall
```

It links rather than copies, so `supi` is always the `src/index.ts` in your checkout — edit the
CLI and the next invocation is the edited one, with nothing to rebuild. The cost of that choice is
that moving or deleting the repository breaks the command, which is the right trade for a CLI you
are working on and the wrong one for shipping to a stranger. There is no published artifact yet.

It requires [bun](https://bun.sh) — `src/index.ts` runs directly under its own shebang. The
installer checks for it up front rather than letting the first invocation fail as
`bad interpreter`, which names the wrong problem. Uninstalling needs no runtime.

Nothing in `$BIN_DIR` is overwritten unless this installer put it there: both names are checked
before either is written, so a refusal leaves no half-install behind, and `--uninstall` removes
only its own links.

The third consumer of `@superpipeline/contract`, after the Worker's REST routes and its MCP server.
The contract's own comment states the rule this follows:

> Surface-neutral verb input/output schemas. The same schema validates a call whether it arrives
> over MCP or REST — there is exactly one contract.

`supi` is a client. It adds no authority, validates no permissions locally, and renders the
board's own refusals.

## Signing in and staying signed in

Install AgentPod's standalone `fleet` client, then run:

```sh
fleet login
supi whoami
supi boards
```

`supi` uses hub-issued tokens and the device credential created by `fleet login`.
It checks `SUPERPIPELINE_TOKEN`, then `AGENTPOD_TOKEN`, then fleet's token cache.
If the cache is absent, malformed or expired, it exchanges the stored device
credential for a fresh five-minute token and caches that token for later commands.
No browser interaction is needed while the device credential remains usable.

Explicit environment tokens take precedence even when expired. Replace or unset
an expired variable; `supi` will not silently switch to a different disk identity.
Without a usable device credential, run `fleet login` again. A refused exchange
also asks for a new login; a network/server failure asks you to retry. No API write
is automatically replayed.

The files are `agentpod/token.json` and `agentpod/device.json` under the same
platform config directory as fleet: `$XDG_CONFIG_HOME` (or `~/.config`) on Linux,
`~/Library/Application Support` on macOS, and `%AppData%` on Windows. The device
secret goes only to the issuer recorded in `device.json`, with redirects disabled.
HTTPS is required except for loopback development hubs. Token-cache replacement
is atomic and private (0600); the device file is never modified. If caching fails,
the fresh token still works for that command.

`SUPERPIPELINE_URL` changes the work API destination (default
`https://app.superpipeline.dev`), not the issuer used for device exchange.
Superpipeline verifies the resulting token and its audience/authority at the API.
This reuses the existing fleet credential protocol; it does not add a separate
Superpipeline login or change the suite's identity agreements.

## When an AGENT is the one running it

`supi` is driven by agents as well as people, and the two must never be confused: the board
records which of them asked for a card, and that record is the point.

An agent credential comes from one of two places, both outranking every human slot:

| | |
|---|---|
| `SUPERPIPELINE_AGENT_TOKEN_FILE` | a path, re-read on **every** invocation |
| `SUPERPIPELINE_AGENT_TOKEN` | a value in the environment |

Two kinds of token count as an agent's, and they look nothing alike:

- **`spa_…`** — superpipeline's own token. Opaque: a random secret with no claims. It reads and
  plans, and it cannot queue work, because it carries no dispatch grant.
- **a hub JWT whose `principalKind` is `agent`** — a *station token*. This one carries
  `mayDispatch`, so it is the only credential that can queue a card or move one.

A station token lives about five minutes, deliberately: verification is offline and there is no
revocation list, so the expiry *is* the revocation window. That is why the FILE exists — something
has to keep it fresh, and `supi` reads it afresh each run. On an AgentPod node, the node-agent does
that: set `stationTokens` in its config and point this variable at the path it writes.

Two refusals rather than guesses, both for the same reason — a credential that silently becomes
somebody else's is the worst outcome available:

- a **human's** token in either agent slot is refused, by its `principalKind` and not by its shape
- a token **file that is named but missing or empty** is refused outright, never fallen back from.
  A refresher that stopped must read as broken, not as "act as the operator instead".

`supi whoami` says which identity is in force, where the credential came from, and when it dies.

## What it can do

The CLI reads boards, cards and pending gates, moves cards, lists templates, and
creates boards with `supi create-board <name> [--template <id>] [--stages <file|->]`.
`supi board-queuers <boardId> [--add <principalId> | --remove <principalId>]` lists, adds or
removes the principals (for example a service token's `prn_` id) that may queue cards on a board
besides its members; changing the list needs board admin. It renders the server's decisions
rather than granting authority itself.

A hub identity linked to a local Superpipeline account uses that account's actual
workspace role. An unmapped principal falls back to `member`; that fallback is
not a ceiling on linked users. Board creation therefore works when the server
grants the caller the necessary seat. Staffing agents, editing capabilities and
changing the fleet link are not CLI verbs.

The CLI never discovers credentials from agent-token variables or the node
agent's enrollment config. A `spa_` agent credential is not a substitute for a
human's fleet credential. **401** means the credential was not accepted;
**403** means the server refused that operation with the caller's authority.

## Installing

```sh
curl -fsSL https://github.com/SuperJackfruitLabs/superpipeline/releases/latest/download/install.sh | bash
```

One binary under two names in `~/.local/bin`, verified against the release's `SHA256SUMS` before
it is installed. `VERSION=v0.0.2` pins a tag; `BIN_DIR=…` installs elsewhere. No sudo, no service.

Binaries are published for darwin and linux, arm64 and x64, built with `bun build --compile` — a
standalone executable, so Bun is not needed to run one. Building from a checkout instead:

```sh
bun build --compile packages/cli/src/index.ts --outfile supi
```

## Keeping it current

```sh
supi update            # replace this binary with the newest release
supi update --check    # say what is available, change nothing
supi version           # what this binary was built as
```

`update` resolves the latest release, downloads the asset for this platform, checks it against the
release's `SHA256SUMS`, and replaces the running binary by an atomic rename. A download it cannot
verify is refused rather than installed.

This verb exists because of what happened without one. `agentpod-fleet` shipped with no way to
update itself and was found sitting at **v0.1.52** on a developer's machine while **v0.1.66** was
current — fourteen releases behind, published the whole time by the same workflow that published
the binary beside it. `agentpod-node`, which self-updates, was current on that same machine. A CLI
a person runs by hand drifts *more* than a service does, because nothing ever forces the upgrade.

A binary built outside the release pipeline reports its version as `dev` and is always treated as
out of date, so an unidentifiable binary is offered the update rather than quietly left alone.
