---
title: "Comments on a card"
description: "supi comment and comments."
sidebar:
  label: "Comments"
  order: 5
---

<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

A card's comment thread: remarks from people, and from the agent working the card. Anyone who may read the board may comment; an agent may comment only on the card its live run holds. Nobody edits a comment, and only its author can delete one, from the web app. The agent that claims a card is handed the newest comments with it, and is told to re-read the thread before it finishes the stage.

Every command here also takes `--json` and `--help` — see [the overview](/reference/cli/).

## `supi comment`

Adds a comment to the card, attributed to whoever holds the credential — a person by their account, an agent by its name. It appears in the card drawer straight away for anyone watching.

An agent working the card sees it: the newest comments travel with the card when an agent claims it, and an agent mid-run re-reads the thread (`superpipeline_list_comments`) before it finishes the stage. A comment does not interrupt a run that is already working, and it is not a gate decision — use `request-changes` to send work back.

```sh
supi comment <boardId> <cardId> <text>
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<cardId>` | the card, as `crd_…` (see `supi board <boardId>`) |
| `<text>` | the comment, as Markdown text of at most 8 KB; every remaining word is part of it, or `-` to read it from stdin (takes every remaining word) |

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** the `run` scope.

An agent may comment only on a card its live run holds; on any other card it is refused (403), whatever its scopes.

**Calls** `POST /v1/boards/:boardId/cards/:cardId/comments`

**Prints** JSON: the comment.

**Exit status** `0` on success. `1` when:

- `<boardId>`, `<cardId>` or the text is missing
- the text is over 8 KB (the server's 400)
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi comment brd_8f2c… crd_41aa… Please also cover the expired-token path
git diff --stat | supi comment brd_8f2c… crd_41aa… -
```

## `supi comments`

The card's comment thread, oldest first: who wrote each one (a person or an agent), when, and what it says. A deleted comment is shown as deleted, with its author and time but not its text.

```sh
supi comments <boardId> <cardId>
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<cardId>` | the card, as `crd_…` (see `supi board <boardId>`) |

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** the `read` scope.

**Calls** `GET /v1/boards/:boardId/cards/:cardId/comments`

**Prints** the thread, readable; `--json` for the server's response.

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<cardId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi comments brd_8f2c… crd_41aa…
```
