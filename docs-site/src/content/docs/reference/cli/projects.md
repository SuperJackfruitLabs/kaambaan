---
title: "Projects and milestones"
description: "supi project list, add, show and rm; supi milestone add and rm."
sidebar:
  label: "Projects and milestones"
  order: 9
---

<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

A project groups cards across boards; a milestone is an ordered step inside one project.

Every command here also takes `--json` and `--help` — see [the overview](/reference/cli/).

## `supi project list`

Every project in the workspace, with its target date and lead. A project groups cards from any board.

```sh
supi project list
```

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** the `read` scope.

**Calls** `GET /v1/projects`

**Prints** one project per line; `--json` for the server's response.

**Exit status** `0` on success. `1` when:

- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi project list
```

## `supi project add`

Declares a project in the workspace. Cards from any board can then be grouped under it.

```sh
supi project add <name> [--description <text>] [--target YYYY-MM-DD] [--lead <userId>]
```

| argument | meaning |
|---|---|
| `<name>` | the project's name |

| flag | type | default | meaning |
|---|---|---|---|
| `--description <text>` | string | none | what the project is for |
| `--target YYYY-MM-DD` | date, `YYYY-MM-DD` | no target date | the target date; must be a date in `YYYY-MM-DD` form (checked before anything is sent) |
| `--lead <userId>` | string | no lead | the person who leads it |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** the `plan` scope.

**Calls** `POST /v1/projects`

**Prints** JSON: the created project.

**Exit status** `0` on success. `1` when:

- `<name>` is missing
- `--target` is not `YYYY-MM-DD`
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi project add 'Q4 hardening' --target 2026-12-15 --description 'auth and tenancy fixes'
```

## `supi project show`

One project and its milestones, ordered by their sort order and then by name.

```sh
supi project show <projectId>
```

| argument | meaning |
|---|---|
| `<projectId>` | the project (see `supi project list`) |

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** the `read` scope.

**Calls** `GET /v1/projects/:projectId`

**Prints** the project and its milestones; `--json` for the server's response.

**Exit status** `0` on success. `1` when:

- `<projectId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi project show prj_5b10…
```

## `supi project rm`

Removes a project. Cards that carried it keep the id and show nothing for it.

```sh
supi project rm <projectId>
```

| argument | meaning |
|---|---|
| `<projectId>` | the project |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

**Calls** `DELETE /v1/projects/:projectId`

**Prints** `Deleted <projectId>.`; `--json` for `{ deleted }`.

**Exit status** `0` on success. `1` when:

- `<projectId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi project rm prj_5b10…
```

## `supi milestone add`

Adds a milestone to a project. Milestones are shown in `--sort` order, then by name.

```sh
supi milestone add <projectId> <name> [--target YYYY-MM-DD] [--sort <n>]
```

| argument | meaning |
|---|---|
| `<projectId>` | the project it belongs to |
| `<name>` | the milestone's name |

| flag | type | default | meaning |
|---|---|---|---|
| `--target YYYY-MM-DD` | date, `YYYY-MM-DD` | no target date | the target date; must be a date in `YYYY-MM-DD` form (checked before anything is sent) |
| `--sort <n>` | number | the server's default order | its position within the project, ascending |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** the `plan` scope.

**Calls** `POST /v1/projects/:projectId/milestones`

**Prints** JSON: the created milestone.

**Exit status** `0` on success. `1` when:

- `<projectId>` or `<name>` is missing
- `--target` is not `YYYY-MM-DD`, or `--sort` is not a number
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi milestone add prj_5b10… 'Beta' --target 2026-11-15 --sort 1
```

## `supi milestone rm`

Removes one milestone without touching its project. Cards that carried it keep the id.

```sh
supi milestone rm <milestoneId>
```

| argument | meaning |
|---|---|
| `<milestoneId>` | the milestone (see `supi project show`) |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

**Calls** `DELETE /v1/milestones/:milestoneId`

**Prints** `Deleted <milestoneId>.`; `--json` for `{ deleted }`.

**Exit status** `0` on success. `1` when:

- `<milestoneId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi milestone rm mst_2c7e…
```
