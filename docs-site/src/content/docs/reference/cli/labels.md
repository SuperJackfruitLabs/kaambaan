---
title: "Labels"
description: "supi label list, label add and label rm."
sidebar:
  label: "Labels"
  order: 7
---

<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

The workspace's label catalogue — the one a card's labels are resolved against.

Every command here also takes `--json` and `--help` — see [the overview](/reference/cli/).

## `supi label list`

Every label declared in the workspace, with its id and colour.

```sh
supi label list
```

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** the `read` scope.

**Calls** `GET /v1/labels`

**Prints** JSON: the labels.

**Exit status** `0` on success. `1` when:

- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi label list
```

## `supi label add`

Declares a label in the workspace catalogue, so cards can be tagged with it by id (`create-card --label`).

```sh
supi label add <name> <colour>
```

| argument | meaning |
|---|---|
| `<name>` | the label's name |
| `<colour>` | its colour, as the web app accepts it (for example `#d97706`) |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

**Calls** `POST /v1/labels`

**Prints** JSON: the created label.

**Exit status** `0` on success. `1` when:

- `<name>` or `<colour>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi label add security '#dc2626'
```

## `supi label rm`

Removes a label. Cards that carried it keep the id and show nothing for it.

```sh
supi label rm <id>
```

| argument | meaning |
|---|---|
| `<id>` | the label's id (see `supi label list`) |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

**Calls** `DELETE /v1/labels/:id`

**Prints** `Deleted <id>.`; `--json` for `{ deleted }`.

**Exit status** `0` on success. `1` when:

- `<id>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi label rm lbl_sec
```
