---
title: "Cards"
description: "supi card, create-card, move, archive and log."
sidebar:
  label: "Cards"
  order: 4
---

<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

Reading one card, queueing new work, moving it between stages, and reading what an agent did on it.

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
