---
title: "Cards"
description: "supi card, create-card, edit-card, move, archive and log."
sidebar:
  label: "Cards"
  order: 4
---

<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

Reading one card, queueing new work, editing it, moving it between stages, and reading what an agent did on it.

Every command here also takes `--json` and `--help` — see [the overview](/reference/cli/).

## `supi card`

One card: its fields, stage, labels, references and state.

```sh
supi card <boardId> <cardId>
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<cardId>` | the card, as `crd_…` (see `supi board <boardId>`) |

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** the `read` scope.

**Calls** `GET /v1/boards/:boardId/cards/:cardId`

**Prints** JSON: the card.

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<cardId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi card brd_8f2c… crd_41aa…
```

## `supi create-card`

Creates a card in the board's first stage. The card records the credential that queued it as its grant — who asked for the work and on whose authority. An agent's card is also bounded by the queueing policy `supi agent queueing` sets: which boards may receive it, whose work it is, and how many cards an hour.

```sh
supi create-card <boardId> <title> [--spec <file|->] [--priority <n>] [--due YYYY-MM-DD] [--label <id>...]
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<title>` | the card's title; every remaining word is part of it, so it needs no quoting (takes every remaining word) |

| flag | type | default | meaning |
|---|---|---|---|
| `--spec <file\|->` | file path, or `-` for stdin | no spec | the card's structured spec, as JSON from a file or stdin |
| `--priority <n>` | number | `0` | the card's priority |
| `--due YYYY-MM-DD` | date, `YYYY-MM-DD` | no due date | the due date; must be a date in `YYYY-MM-DD` form (checked before anything is sent) |
| `--label <id>` | string | no labels | a label id from `supi label list`; repeat for more than one. Applied by a second request after the card exists. Repeatable |

**Who may run it**

- **A person:** `member` or above in the workspace.
- **An agent token:** the `queue` scope.

The PATCH that applies `--label` also needs `plan` on an agent token. An agent's card is bounded by its queueing policy and dispatch grant.

**Calls** `POST /v1/boards/:boardId/cards`, then `PATCH /v1/boards/:boardId/cards/:cardId`

**Prints** JSON: the created card (or, with `--label`, the card after its labels are applied).

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<title>` is missing
- `--spec` cannot be read or is not JSON
- `--due` is not `YYYY-MM-DD`
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi create-card brd_8f2c… Write the release notes for 0.0.9
supi create-card brd_8f2c… Audit the token routes --spec spec.json --priority 2 --due 2026-11-01 --label lbl_sec
```

## `supi edit-card`

Edits a card through the same `PATCH` the web app's card drawer sends, with the same authority. Only the fields named change. Labels, owner and archiving have their own verbs and routes.

`--merge-spec` is a read-modify-write: it reads the card, merges into the spec it read, and writes back with `expectedUpdatedAt` set to the card's `updatedAt` as read. If anything changed the card in between — an edit in the drawer, a claim, a move — the server answers 409 and nothing is written; run the command again to merge into the card as it now is. `--spec` replaces the spec outright and sends no precondition.

```sh
supi edit-card <boardId> <cardId> [--title <text>] [--spec <file|->] [--merge-spec <file|->] [--priority <n>] [--due YYYY-MM-DD|none]
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<cardId>` | the card, as `crd_…` (see `supi board <boardId>`) |

| flag | type | default | meaning |
|---|---|---|---|
| `--title <text>` | string | unchanged | the card's new title (quote it if it has spaces) |
| `--spec <file\|->` | file path, or `-` for stdin | unchanged | a new spec, as JSON from a file or stdin. It REPLACES the spec whole — every key not in it is gone |
| `--merge-spec <file\|->` | file path, or `-` for stdin | unchanged | a JSON object whose top-level keys are merged into the existing spec: a key given replaces that key (a nested object is replaced, not merged into), a key set to `null` is removed, every other key is kept. Cannot be combined with `--spec` |
| `--priority <n>` | number | unchanged | the card's new priority |
| `--due YYYY-MM-DD\|none` | string | unchanged | the new due date, or `none` to clear it; a date must be a date in `YYYY-MM-DD` form (checked before anything is sent) |

**Who may run it**

- **A person:** `member` or above in the workspace.
- **An agent token:** the `plan` scope.

With `--merge-spec` the card is read (the GET) before the PATCH, which needs `read` as well on an agent token.

**Calls** `PATCH /v1/boards/:boardId/cards/:cardId`, then `GET /v1/boards/:boardId/cards/:cardId`

**Prints** JSON: the card after the edit.

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<cardId>` is missing
- no field to change was given
- both `--spec` and `--merge-spec` were given
- `--spec` or `--merge-spec` cannot be read or is not JSON; `--merge-spec` is not a JSON object
- `--merge-spec` on a card whose spec is not a JSON object
- `--priority` is not a number; `--due` is neither `YYYY-MM-DD` nor `none`
- the card changed between the read and the write (`--merge-spec`; the server's 409)
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi edit-card brd_8f2c… crd_41aa… --title "Write the 0.0.9 release notes" --priority 2
supi edit-card brd_8f2c… crd_41aa… --merge-spec acceptance.json
echo '{"notes": null}' | supi edit-card brd_8f2c… crd_41aa… --merge-spec -
supi edit-card brd_8f2c… crd_41aa… --due none
```

## `supi move`

Moves a card to another stage. Moving a card into a stage an agent works is a dispatch, so the mover is recorded as the one who queued it — and an agent mover passes the same queueing checks a create does.

```sh
supi move <boardId> <cardId> <stageKey>
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<cardId>` | the card, as `crd_…` (see `supi board <boardId>`) |
| `<stageKey>` | the stage to move it to |

**Who may run it**

- **A person:** `member` or above in the workspace.
- **An agent token:** the `plan` scope.

An agent moving a card into an agent-owned stage also needs a dispatch grant and a queueing policy that permits it.

**Calls** `POST /v1/boards/:boardId/cards/:cardId/move`

**Prints** JSON: the moved card.

**Exit status** `0` on success. `1` when:

- `<boardId>`, `<cardId>` or `<stageKey>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi move brd_8f2c… crd_41aa… review
```

## `supi resume`

Resumes a card in `input-required` — blocked by its agent, refused twice at its stage's completion check, stopped by the circuit breaker, or refused dispatch. The card returns to its stage (or `--stage`, an earlier one) as `submitted`, its "needs a person" reason is cleared, and the stage starts over: the failure count is reset and the automatic rework is owed again. Agents that can claim the stage are told it is available.

The comment is stored twice: on the card's thread, and as `feedback` in the handoff the next claim carries — the same place a reviewer's `request-changes` comment goes. Resuming re-queues the card, so you become its queuer, as on a move.

Not for an open question (answer it on the card) or a pending review (use `approve` or `request-changes`): both are refused with a pointer to the right action. To send a card forward, use `move`.

```sh
supi resume <boardId> <cardId> --comment <text> [--stage <key>]
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<cardId>` | the card, as `crd_…` (see `supi board <boardId>`) |

| flag | type | default | meaning |
|---|---|---|---|
| `--comment <text>` | string | **required** | what changed, or what to do differently. Kept on the card's comment thread and handed to the next agent as `feedback` |
| `--stage <key>` | string | the card's current stage | send it back to this earlier stage instead |

**Who may run it**

- **A person:** `member` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

Resuming is the human half of a block: an agent token is refused (403) whatever its scopes.

**Calls** `POST /v1/boards/:boardId/cards/:cardId/resume`

**Prints** JSON: the card and the comment.

**Exit status** `0` on success. `1` when:

- `<boardId>`, `<cardId>` or `--comment` is missing
- the card is not waiting on a person (the server's 409)
- the card has an open question or a pending review (409, naming what to do instead)
- `--stage` is after the card's stage, or unknown (400)
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi resume brd_8f2c… crd_41aa… --comment "Staging is back up; run the migration again."
supi resume brd_8f2c… crd_41aa… --stage plan --comment "Re-plan this without the staging database."
```

## `supi stale`

Lists the cards that are waiting and will go on waiting unless somebody acts: cards in `input-required` (with the reason the card gives — blocked, repeated failure, a question, a review, refused dispatch), and cards sitting in a stage nothing claims — no agent owns it, it has no approval gate, and it is not the last stage. For each: the board, the card, its stage, why it is stuck, how long it has been there, and what to do next.

Age is counted from when the card last changed state or stage. Without `--hours` each board's own threshold applies and a board that switched stale cards off is left out.

```sh
supi stale [--hours <n>]
```

| flag | type | default | meaning |
|---|---|---|---|
| `--hours <n>` | number | each board's own threshold (24 unless set with `set-stale`) | list cards stuck at least this long, on every board, whatever its switch says; `0` lists everything waiting now |

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** the `read` scope.

**Calls** `GET /v1/stale`

**Prints** the stuck cards, grouped by board; `--json` for the server's response.

**Exit status** `0` on success. `1` when:

- `--hours` is not a number of hours, 0 or more
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi stale
supi stale --hours 0 --json
```

## `supi archive`

Archives a card now. It leaves the board's lanes and appears under the web app's "show archived" filter.

```sh
supi archive <boardId> <cardId>
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<cardId>` | the card, as `crd_…` (see `supi board <boardId>`) |

**Who may run it**

- **A person:** `member` or above in the workspace.
- **An agent token:** the `plan` scope.

**Calls** `PATCH /v1/boards/:boardId/cards/:cardId`

**Prints** JSON: the archived card.

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<cardId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi archive brd_8f2c… crd_41aa…
```

## `supi log`

The card's activity transcript — what each agent posted, in order — its handoff, and its gates.

```sh
supi log <boardId> <cardId>
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<cardId>` | the card, as `crd_…` (see `supi board <boardId>`) |

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** the `read` scope.

**Calls** `GET /v1/boards/:boardId/cards/:cardId/activities`

**Prints** the transcript, readable; `--json` for the server's response.

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<cardId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi log brd_8f2c… crd_41aa…
```
