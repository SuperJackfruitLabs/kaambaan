---
title: "supi command reference"
description: "Every supi command, flag and environment variable, generated from the CLI's own command table."
sidebar:
  label: "Overview"
  order: 1
---

<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

`supi` is superpipeline from a terminal; `superpipeline` is the same program under its full name. These pages are generated from the table the CLI's own `supi help` is printed from, so the two cannot disagree. For a guided tour rather than a reference, see [From the terminal](/use/cli/).

```sh
supi <verb> [<sub-verb>] [<arguments>] [--flags] [--json]
supi help <verb> [<sub-verb>]
```

The verb comes first. Flags may be written `--name value` or `--name=value`, anywhere after the verb, before or after the positional arguments. A value that itself starts with `--` must use the `=` form.

## Commands

### Signing in and the binary

| command | what it does |
|---|---|
| [`supi login`](/reference/cli/session/#supi-login) | sign in to this server's organization plane (device flow) |
| [`supi logout`](/reference/cli/session/#supi-logout) | forget that sign-in on this machine |
| [`supi whoami`](/reference/cli/session/#supi-whoami) | who the stored token says you are |
| [`supi help`](/reference/cli/session/#supi-help) | this summary, or one command in full (also `supi <verb> --help`) |
| [`supi version`](/reference/cli/session/#supi-version) | print this binary's version |
| [`supi update`](/reference/cli/session/#supi-update) | replace this binary with the newest release |

### Boards and pipelines

| command | what it does |
|---|---|
| [`supi boards`](/reference/cli/boards/#supi-boards) | the workspace's boards |
| [`supi board`](/reference/cli/boards/#supi-board) | one board: its stages and their cards |
| [`supi templates`](/reference/cli/boards/#supi-templates) | the starting pipelines --template accepts |
| [`supi create-board`](/reference/cli/boards/#supi-create-board) | create a board; --template defaults to `simple` |
| [`supi set-stages`](/reference/cli/boards/#supi-set-stages) | replace a board's pipeline |
| [`supi set-stale`](/reference/cli/boards/#supi-set-stale) | set when a board's waiting cards count as stale, or switch it off |
| [`supi set-stage`](/reference/cli/boards/#supi-set-stage) | change ONE stage, leaving the others alone |

### Cards

| command | what it does |
|---|---|
| [`supi card`](/reference/cli/cards/#supi-card) | one card in full |
| [`supi create-card`](/reference/cli/cards/#supi-create-card) | queue a card, with this token as its grant |
| [`supi edit-card`](/reference/cli/cards/#supi-edit-card) | change a card's title, spec, priority or due date |
| [`supi move`](/reference/cli/cards/#supi-move) | move a card to another stage |
| [`supi resume`](/reference/cli/cards/#supi-resume) | send a card that is waiting on a person back to work, with a comment |
| [`supi stale`](/reference/cli/cards/#supi-stale) | cards stuck waiting, across every board in the workspace |
| [`supi archive`](/reference/cli/cards/#supi-archive) | archive a card, so the "show archived" filter has something to show |
| [`supi log`](/reference/cli/cards/#supi-log) | what an agent did on a card, and its handoff |

### Comments on a card

| command | what it does |
|---|---|
| [`supi comment`](/reference/cli/comments/#supi-comment) | add a comment to a card |
| [`supi comments`](/reference/cli/comments/#supi-comments) | read a card's comments |

### Approval gates

| command | what it does |
|---|---|
| [`supi gates`](/reference/cli/gates/#supi-gates) | approval gates waiting on a human |
| [`supi approve`](/reference/cli/gates/#supi-approve) | approve a gate: the card moves on |
| [`supi reject`](/reference/cli/gates/#supi-reject) | reject a gate |
| [`supi request-changes`](/reference/cli/gates/#supi-request-changes) | send the card back for rework, saying what to change |

### Links between cards

| command | what it does |
|---|---|
| [`supi link add`](/reference/cli/links/#supi-link-add) | declare an edge between two cards |
| [`supi link rm`](/reference/cli/links/#supi-link-rm) | remove an edge |
| [`supi link list`](/reference/cli/links/#supi-link-list) | every edge touching a card — same-board and cross-board, kept apart |

### Labels

| command | what it does |
|---|---|
| [`supi label list`](/reference/cli/labels/#supi-label-list) | the workspace's label catalogue |
| [`supi label add`](/reference/cli/labels/#supi-label-add) | declare a label |
| [`supi label rm`](/reference/cli/labels/#supi-label-rm) | remove a label (cards keep the stale id) |

### Projects and milestones

| command | what it does |
|---|---|
| [`supi project list`](/reference/cli/projects/#supi-project-list) | the workspace's projects (group cards across boards) |
| [`supi project add`](/reference/cli/projects/#supi-project-add) | declare a project |
| [`supi project show`](/reference/cli/projects/#supi-project-show) | a project with its milestones, in order |
| [`supi project rm`](/reference/cli/projects/#supi-project-rm) | remove a project (cards keep the stale id) |
| [`supi milestone add`](/reference/cli/projects/#supi-milestone-add) | add a milestone to a project |
| [`supi milestone rm`](/reference/cli/projects/#supi-milestone-rm) | remove a milestone (cards keep the stale id) |

### Recurring cards

| command | what it does |
|---|---|
| [`supi schedule list`](/reference/cli/schedules/#supi-schedule-list) | the board's recurring cards |
| [`supi schedule add`](/reference/cli/schedules/#supi-schedule-add) | declare a schedule |
| [`supi schedule rm`](/reference/cli/schedules/#supi-schedule-rm) | remove a schedule |
| [`supi schedule pause`](/reference/cli/schedules/#supi-schedule-pause) | stop a schedule firing, keeping it |
| [`supi schedule resume`](/reference/cli/schedules/#supi-schedule-resume) | start a paused schedule firing again |

### Workspace, agents and capabilities

| command | what it does |
|---|---|
| [`supi forge`](/reference/cli/workspace/#supi-forge) | this workspace's forge host, shown or set |
| [`supi agents`](/reference/cli/workspace/#supi-agents) | the workspace's agents and what they declare |
| [`supi agent create`](/reference/cli/workspace/#supi-agent-create) | create an agent, linked to its principal as it is made |
| [`supi agent mint-token`](/reference/cli/workspace/#supi-agent-mint-token) | mint an agent's token: claim-run or run-only, shown once |
| [`supi agent queueing`](/reference/cli/workspace/#supi-agent-queueing) | what an agent may queue of its OWN: owner, boards, cards an hour |
| [`supi capabilities`](/reference/cli/workspace/#supi-capabilities) | the capability registry, with each one's origin |
| [`supi capability define`](/reference/cli/workspace/#supi-capability-define) | say what a capability means, declaring it if it is new |
| [`supi implications`](/reference/cli/workspace/#supi-implications) | what one capability implies about another |

## Flags every command takes

| flag | type | default | meaning |
|---|---|---|---|
| `--json` | boolean | off: readable output where a renderer exists | machine-stable JSON, on any command. A response with no readable renderer prints JSON either way |
| `--help` | boolean | off | print this command's help instead of running it |

## Signing in

A person signs in once with `supi login`. It finds the server's sign-in service from the server itself (`/.well-known/oauth-protected-resource`) — for app.superpipeline.dev that is **https://accounts.superjackfruit.com**, the same account you use in the web app — and runs its device flow: open the printed link, confirm the code, and `supi` keeps a device credential of its own. Every command after that exchanges it for a token that lives minutes, without a browser.

The credential a command acts with is the first of these that exists:

1. `$SUPERPIPELINE_AGENT_TOKEN_FILE` — an agent; the file is re-read on every run
2. `$SUPERPIPELINE_AGENT_TOKEN` — an agent
3. `$SUPERPIPELINE_TOKEN` — a person's token, used exactly as supplied
4. `$AGENTPOD_TOKEN` — a person's hub token, used exactly as supplied
5. `supi login`'s cached token, while it is fresh
6. `supi login`'s device credential, exchanged at the sign-in service recorded at login
7. the token AgentPod's `fleet login` cached — skipped when it was issued for a different audience, which is the case once a server has moved to the sign-in service
8. `fleet login`'s device credential — exchanged at the sign-in service it recorded for this server's audience (and cached in supi's own directory, never in fleet's), or, for a server not yet on the sign-in service, renewed at the hub it recorded

Steps 7 and 8 exist so a machine already signed in with `fleet login` needs no second sign-in. Environment tokens are never renewed and never silently swapped for a file on disk: when one expires, replace or unset it. An agent credential is never renewed either, and a person's token in an agent slot (or an `spa_` token in a person's slot) is refused rather than used.

Credentials live under the platform config directory — `$XDG_CONFIG_HOME` (or `~/.config`) on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows — in `superpipeline/device.json` and `superpipeline/token.json` for `supi login`, and `superpipeline/fleet-token.json` for a token exchanged from fleet's device. They are written atomically with mode 0600. A device credential is sent only to the service it was issued by, over HTTPS (plain HTTP only on loopback), with redirects disabled.

## Environment

| variable | read by | meaning |
|---|---|---|
| `SUPERPIPELINE_AGENT_TOKEN_FILE` | `supi` | a FILE holding an agent credential, re-read on every run. Outranks every other credential. Named but missing or empty is a refusal, never a fall-back to somebody else's credential |
| `SUPERPIPELINE_AGENT_TOKEN` | `supi` | an agent credential: an `spa_…` token, or an agent JWT. A person's token here is refused by its kind |
| `SUPERPIPELINE_TOKEN` | `supi` | a person's token, used as supplied: never renewed, never replaced. An `spa_` token here is refused — it belongs in `SUPERPIPELINE_AGENT_TOKEN` |
| `AGENTPOD_TOKEN` | `supi` | a person's AgentPod hub token, used as supplied. Only a server still verifying hub tokens accepts it; app.superpipeline.dev refuses it, so do not export it into a shell that runs `supi` — it outranks `supi login` and every command would answer 401 |
| `SUPERPIPELINE_URL` | `supi` | the superpipeline server to talk to. Default `https://app.superpipeline.dev`. It changes where commands go and which audience a token is requested for, never where a device credential is sent |
| `XDG_CONFIG_HOME` | `supi` | Linux: the config directory credentials live under (default `~/.config`) |
| `APPDATA` | `supi` | Windows: the config directory credentials live under |
| `BIN_DIR` | the installer | where the installer puts `supi` and `superpipeline` (default `~/.local/bin`) |
| `VERSION` | the installer | a release tag for the installer to pin, instead of the latest |
| `SKILL_DIR` | the installer | where the installer also places the agent skill; unset, no skill is installed |

## Who may run what

`supi` adds no authority and checks no permission itself: the server decides, and a refusal is printed as it arrives. Each command's page lists what the server asks for, two ways:

- **A person** needs a workspace role: `viewer` < `member` < `admin` < `owner`, each including the ones before it. See [People and roles](/use/people/).
- **An agent token** needs a scope — `read`, `queue`, `plan` or `compose` for a coordinator. An `spa_` token reads and plans; only an agent JWT (a station token) carries the dispatch grant that queues work. Deciding a gate is refused to every agent token. See [Authentication](/build/auth/#scopes).

## Exit status and errors

`0` when the command did what it says; `1` for everything else — a usage error, a missing or expired credential, a refusal, a server error, a network failure. The message goes to standard error, followed by a hint where there is one. Output goes to standard output, so `--json` output can be piped safely.

- **401** means sign in: `supi login`.
- **403** means your role or your token's scopes do not permit this. The two are never conflated, because telling somebody to sign in again when the answer is "you may not" sends them round a loop.
