---
title: From the terminal
description: supi — boards, cards, gates, links, projects, schedules and runbooks, without a browser.
---

`supi` is superpipeline from a terminal. It is also installed as `superpipeline` — the same program
under its full name, for scripts that should read plainly. It is a client: it adds no authority of
its own and renders the board's answers, including its refusals.

This page is a tour. Every command, flag, default and environment variable — and who may run each
one — is in the [command reference](/reference/cli/), generated from the CLI itself; `supi help
<verb>` prints the same entry in a terminal.

## Installing

```sh
curl -fsSL https://github.com/SuperJackfruitLabs/superpipeline/releases/latest/download/install.sh | bash
```

One binary under two names, into `~/.local/bin` by default (`BIN_DIR` to change it). `VERSION` pins
a release tag. The installer sets up no service, enrolls nothing, and **never asks for sudo** — a
CLI that needs root to update itself is a CLI that stops updating itself.

```sh
supi update            # replace this binary with the newest release
supi update --check    # just say whether one exists
supi version
```

An update resolves the latest tag, downloads the asset for your platform, verifies it against the
release's checksums, and swaps it in atomically. A download it cannot verify is refused rather than
installed.

To run it from a checkout while working on the CLI, `packages/cli/install.sh` links the two names
at the source instead. It requires [bun](https://bun.sh) and never replaces a file it did not put
there.

## Signing in

People sign in to superpipeline with their account at **accounts.superjackfruit.com** — the same
account the web app uses. From a terminal that is one command:

```sh
supi login      # prints a link and a code; confirm the code in your browser
supi whoami     # who you are signed in as, and when the token expires
supi boards
```

`supi login` keeps a device credential of its own and exchanges it for a short-lived token on every
command, so you are not asked for a browser again until that device is revoked. `supi logout`
forgets it on this machine.

If you already ran AgentPod's `fleet login` on this machine, `supi` can use that sign-in instead
and needs no second one. Or supply a token directly:

```sh
SUPERPIPELINE_TOKEN=… supi boards
```

| variable | meaning |
|---|---|
| `SUPERPIPELINE_TOKEN` | a person's token, used exactly as supplied |
| `SUPERPIPELINE_URL` | the deployment to talk to. Defaults to `https://app.superpipeline.dev`. |

Explicit environment tokens are used as supplied and are never renewed or replaced with a disk
identity. If one expires, replace or unset the variable. The full resolution order, every file
`supi` writes and every variable it reads are in the
[command reference](/reference/cli/).

### When an agent is the one running it

An agent acts with `SUPERPIPELINE_AGENT_TOKEN_FILE` — a **file**, re-read every run — or
`SUPERPIPELINE_AGENT_TOKEN`, either outranking every person's credential.

This distinction is load-bearing. An `spa_` token reads and plans. Only an agent JWT — a **station**
token — carries the dispatch grant that queues work and moves cards, and it lives for minutes — so
point the file at something that keeps it fresh, rather than at a value that was true when you set
it.

## Looking at work

```sh
supi boards                           # the workspace's boards
supi board <boardId>                  # one board: its stages and their cards
supi card <boardId> <cardId>          # one card in full
supi log <boardId> <cardId>           # what an agent did on a card, and its handoff
supi capabilities                     # the capability registry, with each one's origin
supi implications                     # what one capability implies about another
supi agents                           # the workspace's agents and what they declare
```

## Deciding

```sh
supi gates <boardId>                  # approval gates waiting on a human
supi approve <boardId> <gateId> [--comment "why"]
supi reject <boardId> <gateId> [--comment "why"]
supi request-changes <boardId> <gateId> --comment "what to change"
```

`request-changes` requires a comment. "Changes requested" with nothing said is a card nobody can
act on.

## Moving work

```sh
supi create-card <boardId> "<title>" [--spec <file|->] [--priority <n>]
                                     [--due YYYY-MM-DD] [--label <id>]...
supi move <boardId> <cardId> <stageKey>
supi archive <boardId> <cardId>
```

A card created here carries **this token** as its grant — the record of who asked for the work.

`--spec` takes the card's brief as a JSON object. Begin it with a plain-language `description`;
`plan` and `acceptanceCriteria` get their own sections in the card drawer and every other field is
shown under **Details**. The agent receives the whole spec either way — see
[The spec](/use/cards/#the-spec).

## Order and grouping

```sh
supi label list
supi label add <name> <colour>
supi label rm <id>

supi project list
supi project add <name> [--description <text>] [--target YYYY-MM-DD] [--lead <userId>]
supi project show <projectId>
supi project rm <projectId>
supi milestone add <projectId> <name> [--target YYYY-MM-DD] [--sort <n>]
supi milestone rm <milestoneId>

supi link add <boardId> <fromCardId> <toCardId> --kind blocks|relates|parent [--to-board <boardId>]
supi link rm  <boardId> <fromCardId> <toCardId> --kind blocks|relates|parent [--to-board <boardId>]
supi link list <boardId> <cardId>
```

`--to-board` names another board, which makes the edge **advisory** — shown, never enforced.
`link list` keeps the enforced and advisory edges apart rather than presenting them as one set.

Removing a label, project or milestone leaves its id on the cards that carried it; they show
nothing rather than a dangling name. See [Planning work](/use/planning/).

## Shaping a board

```sh
supi templates                        # the starting pipelines --template accepts
supi create-board <name> [--template <id>] [--stages <file|->]
supi set-stages <boardId> <file|->    # replace the whole pipeline
supi set-stage <boardId> <stageKey> [--instructions <file|->] [--clear-instructions]
                                     [--name <name>] [--gate none|approval] [--wip <n>|none]
                                     [--owner <capability>] [--completion <file|->] [--clear-completion]
```

**Prefer `set-stage`.** It changes one stage and leaves the others alone, including a concurrent
edit to a stage you did not mean to touch. `set-stages` replaces the pipeline and discards whatever
it was not told about — it has destroyed a board's stage instructions once. See
[Stage runbooks and completion](/use/runbooks/).

## Recurring work

```sh
supi schedule list <boardId>
supi schedule add <boardId> --title <t> --rule <r> --tz <tz>
                            [--stage <key>] [--priority <n>] [--overlap skip|allow]
supi schedule pause  <boardId> <scheduleId>
supi schedule resume <boardId> <scheduleId>
supi schedule rm     <boardId> <scheduleId>
```

A rule is `every <n> minutes|hours|days`, `daily at HH:MM`, `weekly on <mon-sun> at HH:MM`, or
`monthly on <1-28> at HH:MM`. Checked every five minutes, so a card may appear up to five minutes
after its stated time. See [Recurring cards](/use/recurring/).

## Agents and forge

```sh
supi forge [<host>|none]              # this workspace's forge host, shown or set
supi agent queueing <agentId> [--owner <userId>|none] [--boards <id,id,…>|none] [--ceiling <n>]
```

`agent queueing` sets what an agent may queue **of its own**: whose work it owns, which boards may
receive it, and how many cards an hour. `--boards none` is the default and means **no** board — not
every board. See [Agents that plan](/use/autonomy/).

## Output

`--json` on any command gives machine-stable output. The default is readable; a shape with no
renderer prints JSON either way. Everything prints the board's own answer rather than a summary, so
nothing you needed is dropped in the retelling.

## Teaching an agent to use it

The installer can place an agent skill alongside the binary:

```sh
curl -fsSL https://github.com/SuperJackfruitLabs/superpipeline/releases/latest/download/install.sh | SKILL_DIR=~/.claude/skills bash
```

Omitted by default, because most callers are people and a person needs no skill. The skill
describes the surface an agent credential actually has — reading boards, planning, and queueing —
rather than the operator's.

## Workspace authority

You act with your own workspace role, the same one the web app uses. The API checks permissions;
the CLI adds none and bypasses none. Each command's entry in the [reference](/reference/cli/) says
which role, or which agent scope, it needs.

An admin can also register an agent from here — define its capability, create its record linked
to its principal, and mint its tokens (`supi capability define`, `supi agent create`,
`supi agent mint-token`); [Registering an agent](/use/register-an-agent/) walks through it. An
agent credential is refused on all three.

**Not here:** revoking a token or deleting an agent, changing the fleet link, and deciding a gate
as anyone but yourself. What you may do is your seat in the workspace, which the server decides.

## What it will never mix up

A person's credential and an agent's are never interchangeable. `supi` refuses a person's token in
an agent variable, and an `spa_` agent token in a person's — rather than quietly acting as whoever
the token names — and a token file that is named but missing or empty is a refusal, never a
fall-back to the operator's sign-in. The board records who asked for each card, and a CLI that
swapped identities would make that record a lie.

## Reading a refusal

**401** means sign in (`supi login`). **403** means your role or your scopes do not permit this. They are never
conflated — a `member` meeting an `admin` verb gets the second, and being told to sign in again
would send you round a loop. A refusal is printed as it arrives, in the server's own words.
