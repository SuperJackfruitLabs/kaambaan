---
title: "Links between cards"
description: "supi link add, link rm and link list."
sidebar:
  label: "Links"
  order: 7
---

<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

Edges between cards: `blocks`, `relates`, `parent` and `supersedes`. A same-board `blocks` edge is enforced — the blocked card cannot be claimed. An edge to a card on another board is advisory: shown, never enforced.

Every command here also takes `--json` and `--help` — see [the overview](/reference/cli/).

## `supi link add`

Declares an edge from one card to another. `<boardId>` is the from-card's board. A same-board `blocks` edge stops the blocked card being claimed until its blocker is done; with `--to-board` the edge crosses boards and is advisory only.

```sh
supi link add <boardId> <fromCardId> <toCardId> --kind blocks|relates|parent|supersedes [--to-board <boardId>]
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<fromCardId>` | the card the edge starts at |
| `<toCardId>` | the card the edge points to |

| flag | type | default | meaning |
|---|---|---|---|
| `--kind blocks\|relates\|parent\|supersedes` | one of `blocks`, `relates`, `parent`, `supersedes` | **required** | `blocks`: the from-card blocks the to-card (enforced on the same board); `relates`: an informational edge; `parent`: the from-card contains the to-card as a sub-task; `supersedes`: the from-card is the newer card and replaces the to-card (same board only) |
| `--to-board <boardId>` | string | the same board as `<boardId>` | the board the to-card is on. Naming another board makes the edge advisory — stored and shown, never enforced — and `link add` prints a notice saying so before it sends anything |

**Who may run it**

- **A person:** `member` or above in the workspace.
- **An agent token:** the `plan` scope.

**Calls** `POST /v1/boards/:boardId/links`

**Prints** JSON: the edge; a cross-board edge is preceded by a notice that it is advisory.

**Exit status** `0` on success. `1` when:

- a card id is missing
- `--kind` is missing or not one of `blocks`, `relates`, `parent`, `supersedes`
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi link add brd_8f2c… crd_41aa… crd_77b3… --kind blocks
supi link add brd_8f2c… crd_41aa… crd_0d1e… --kind relates --to-board brd_93fa…
```

## `supi link rm`

Removes the edge with exactly this from-card, to-card and kind.

```sh
supi link rm <boardId> <fromCardId> <toCardId> --kind blocks|relates|parent|supersedes [--to-board <boardId>]
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<fromCardId>` | the card the edge starts at |
| `<toCardId>` | the card the edge points to |

| flag | type | default | meaning |
|---|---|---|---|
| `--kind blocks\|relates\|parent\|supersedes` | one of `blocks`, `relates`, `parent`, `supersedes` | **required** | `blocks`: the from-card blocks the to-card (enforced on the same board); `relates`: an informational edge; `parent`: the from-card contains the to-card as a sub-task; `supersedes`: the from-card is the newer card and replaces the to-card (same board only) |
| `--to-board <boardId>` | string | the same board as `<boardId>` | the board the to-card is on. Naming another board makes the edge advisory — stored and shown, never enforced — and `link add` prints a notice saying so before it sends anything |

**Who may run it**

- **A person:** `member` or above in the workspace.
- **An agent token:** the `plan` scope.

**Calls** `DELETE /v1/boards/:boardId/links`

**Prints** JSON: the server's response.

**Exit status** `0` on success. `1` when:

- a card id is missing
- `--kind` is missing or not one of `blocks`, `relates`, `parent`, `supersedes`
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi link rm brd_8f2c… crd_41aa… crd_77b3… --kind blocks
```

## `supi link list`

Every edge touching the card, with the enforced same-board edges and the advisory cross-board edges kept apart.

```sh
supi link list <boardId> <cardId>
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<cardId>` | the card, as `crd_…` (see `supi board <boardId>`) |

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

Not open to agent tokens today.

**Calls** `GET /v1/boards/:boardId/cards/:cardId/links`

**Prints** JSON: the card's edges.

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<cardId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi link list brd_8f2c… crd_41aa…
```
