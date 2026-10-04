---
title: From the terminal
description: supi — boards, cards, gates, links, projects, schedules and runbooks, without a browser.
---

`supi` is superpipeline from a terminal. It is also installed as `superpipeline` — the same program
under its full name, for scripts that should read plainly. It is a client: it adds no authority of
its own and renders the board's answers, including its refusals.

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

`supi` authenticates with a **hub-issued token** — the same credential `fleet login` produces.
superpipeline verifies it offline against the hub's published keys, so one sign-in serves both
planes.

```sh
fleet login     # once, for both planes
supi whoami     # who that token says you are
```

After login, `supi` renews an expired or missing cached token using fleet's device credential,
without opening a browser. A refused exchange asks you to run `fleet login` again; a network
failure asks you to retry.

Or supply one directly:

```sh
SUPERPIPELINE_TOKEN=… supi boards
```

| variable | meaning |
|---|---|
| `SUPERPIPELINE_TOKEN` | a token, used before anything else |
| `AGENTPOD_TOKEN` | the fleet token — what superpipeline actually accepts |
| `SUPERPIPELINE_URL` | the deployment to talk to. Defaults to `https://app.superpipeline.dev`. |

Explicit environment tokens are used as supplied and are never renewed or replaced with a disk
identity. If one expires, replace or unset the variable.

### When an agent is the one running it

An agent acts with `SUPERPIPELINE_AGENT_TOKEN_FILE` — a **file**, re-read every run — or
`SUPERPIPELINE_AGENT_TOKEN`, either outranking all three variables above.

This distinction is load-bearing. An `spa_` token reads and plans. Only a hub-issued **station**
token carries the dispatch grant that queues work and moves cards, and it lives for minutes — so
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
supi set-stage <boardId> <stageKey> [--instructions <file|->] [--name ...]
                                     [--completion <file|->] [--clear-completion]
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
SKILL_DIR=~/.claude/skills curl -fsSL https://github.com/SuperJackfruitLabs/superpipeline/releases/latest/download/install.sh | bash
```

Omitted by default, because most callers are people and a person needs no skill. The skill
describes the surface an agent credential actually has — reading boards, planning, and queueing —
rather than the operator's.

## Workspace authority

A linked hub identity uses its superpipeline account's actual workspace role. Unmapped principals
fall back to `member`; linked owners can create boards. The API checks permissions; the CLI adds
none and bypasses none.

**Not here:** staffing agents, editing capabilities, changing the fleet link, and deciding a gate
as anyone but yourself. What you may do is your seat in the workspace, which the server decides.

## What it will never read

`supi` does not take a human credential from an agent-token variable or the node agent's enrollment
config. An `spa_` **agent** token names an agent, and an agent is not a person operating a board. A
CLI that quietly acted as one would attribute your decisions to it.

## Reading a refusal

**401** means sign in. **403** means your role or your scopes do not permit this. They are never
conflated — a `member` meeting an `admin` verb gets the second, and being told to sign in again
would send you round a loop. A refusal is printed as it arrives, in the server's own words.
