---
title: "Boards and pipelines"
description: "supi boards, board, templates, create-board, set-stages and set-stage."
sidebar:
  label: "Boards and stages"
  order: 3
---

<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

Reading a board, and shaping its pipeline. Prefer `set-stage` over `set-stages`: it changes one stage and leaves the others — and anybody else's concurrent edit to them — alone.

Every command here also takes `--json` and `--help` — see [the overview](/reference/cli/).

## `supi boards`

Every board in the workspace the credential belongs to, with its id.

```sh
supi boards
```

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** the `read` scope.

**Calls** `GET /v1/boards`

**Prints** one board per line; `--json` for the server's `{ boards: [...] }`.

**Exit status** `0` on success. `1` when:

- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi boards
supi boards --json
```

## `supi board`

One board: each stage in order with its owner, gate and limits, and the cards standing in it. `supi board <boardId> --json` prints the snapshot in the shape `create-board --stages` and `set-stages` accept, so a pipeline can be read, edited and put back.

```sh
supi board <boardId>
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** the `read` scope.

**Calls** `GET /v1/boards/:boardId`

**Prints** stages with their cards; `--json` for the board snapshot.

**Exit status** `0` on success. `1` when:

- `<boardId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi board brd_8f2c…
supi board brd_8f2c… --json > pipeline.json
```

## `supi templates`

The board templates shipped with this binary: id, name, description and stage keys. Needs no credential — they are part of the CLI, not fetched.

```sh
supi templates
```

**Who may run it**

Local: sends no credential to superpipeline.

**Prints** JSON: `[{ id, name, description, stages }]`.

**Exit status** `0` on success. `1` when:

- it cannot write its output (never in normal use)

**Example**

```sh
supi templates
```

## `supi create-board`

Creates a board from a template or from a pipeline you supply. `--template` and `--stages` both name the pipeline, so pass at most one. The board checks the stages itself; this only refuses a file that is the wrong kind of thing.

```sh
supi create-board <name> [--template <id>] [--stages <file|->]
```

| argument | meaning |
|---|---|
| `<name>` | the board's name |

| flag | type | default | meaning |
|---|---|---|---|
| `--template <id>` | string | `simple` | start from a shipped template (see `supi templates`) |
| `--stages <file\|->` | file path, or `-` for stdin | the template's stages | read the pipeline from a JSON file, or stdin for `-`: a non-empty array of stages, or an object with a `stages` array (which is what `supi board <boardId> --json` prints). Every stage needs a string `key` |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** the `compose` scope.

**Calls** `POST /v1/boards`

**Prints** JSON: the created board.

**Exit status** `0` on success. `1` when:

- `<name>` is missing, or both `--template` and `--stages` are given
- no template has that id
- the stages file cannot be read, is not JSON, or is not a non-empty array of stages each with a `key`
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi create-board 'Releases' --template software
supi board brd_8f2c… --json | supi create-board 'Copy of releases' --stages -
```

## `supi set-stages`

Replaces every stage of a board. Anything the file does not carry — another stage's instructions, a completion rule, a concurrent edit — is discarded. To change one stage, use `set-stage`.

```sh
supi set-stages <boardId> <file|->
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<file\|->` | the new pipeline: a JSON file, or `-` for stdin, in the same shape `create-board --stages` takes |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

**Calls** `PUT /v1/boards/:boardId/stages`

**Prints** JSON: the board's new stages.

**Exit status** `0` on success. `1` when:

- `<boardId>` or the file is missing
- the file cannot be read, is not JSON, or is not a non-empty array of stages each with a `key`
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi board brd_8f2c… --json > p.json && $EDITOR p.json && supi set-stages brd_8f2c… p.json
```

## `supi set-stage`

Changes the named fields of one stage and nothing else. At least one flag is required. A person may set any field. An agent token with `compose` may set `--instructions` only — the other fields are routing, and the server refuses them by name.

```sh
supi set-stage <boardId> <stageKey> [--instructions <file|->] [--clear-instructions] [--name <name>] [--gate none|approval] [--wip <n>|none] [--owner <capability>] [--completion <file|->] [--clear-completion]
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<stageKey>` | the stage's `key` (see `supi board <boardId>`) |

| flag | type | default | meaning |
|---|---|---|---|
| `--instructions <file\|->` | file path, or `-` for stdin | unchanged | the stage's runbook — prose handed to whoever claims a card here — read from a file, or stdin for `-`. A file rather than a string because shell quoting mangles paragraphs |
| `--clear-instructions` | boolean | off | remove the stage's instructions |
| `--name <name>` | string | unchanged | rename the stage |
| `--gate none\|approval` | one of `none`, `approval` | unchanged | `approval` makes a card wait for a human decision before it leaves the stage |
| `--wip <n>\|none` | integer | unchanged | the most cards the stage may hold at once; `none` removes the limit |
| `--owner <capability>` | string | unchanged | the capability an agent must hold to claim cards here |
| `--completion <file\|->` | file path, or `-` for stdin | unchanged | what a run must produce before the board believes it finished, as JSON from a file or stdin (see Stage runbooks and completion) |
| `--clear-completion` | boolean | off | remove the stage's completion requirement |

**Who may run it**

- **A person:** `member` or above in the workspace.
- **An agent token:** the `compose` scope.

An agent may only send `--instructions`.

**Calls** `PATCH /v1/boards/:boardId/stages/:stageKey`

**Prints** JSON: the updated stage.

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<stageKey>` is missing, or no flag is given (`Nothing to change.`)
- an `--instructions` or `--completion` file cannot be read, or the completion file is not JSON
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi set-stage brd_8f2c… build --instructions runbooks/build.md
supi set-stage brd_8f2c… review --gate approval --wip 3
supi set-stage brd_8f2c… build --clear-completion
```
