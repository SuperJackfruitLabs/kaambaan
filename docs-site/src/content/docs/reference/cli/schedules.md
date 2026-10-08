---
title: "Recurring cards"
description: "supi schedule list, add, rm, pause and resume."
sidebar:
  label: "Schedules"
  order: 10
---

<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

A schedule creates a card on a cadence. Schedules are checked every five minutes, so a card may appear up to five minutes after its stated time.

Every command here also takes `--json` and `--help` — see [the overview](/reference/cli/).

## `supi schedule list`

Every schedule on the board, enabled or paused.

```sh
supi schedule list <boardId>
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

Not open to agent tokens today.

**Calls** `GET /v1/boards/:boardId/schedules`

**Prints** JSON: the schedules.

**Exit status** `0` on success. `1` when:

- `<boardId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi schedule list brd_8f2c…
```

## `supi schedule add`

Declares a schedule that creates a card on the board each time its rule fires.

```sh
supi schedule add <boardId> --title <t> --rule <r> --tz <tz> [--stage <key>] [--priority <n>] [--overlap skip|allow]
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |

| flag | type | default | meaning |
|---|---|---|---|
| `--title <t>` | string | **required** | the title each card it creates carries |
| `--rule <r>` | string | **required** | the cadence: `every <n> minutes\|hours\|days`, `daily at HH:MM`, `weekly on <mon-sun> at HH:MM`, or `monthly on <1-28> at HH:MM`. The server checks the grammar and its refusal says what to type instead |
| `--tz <tz>` | string | **required** | the IANA time zone the rule's times are in, such as `Europe/London` |
| `--stage <key>` | string | the board's first stage | the stage each card is created in |
| `--priority <n>` | number | `0` | each card's priority |
| `--overlap skip\|allow` | one of `skip`, `allow` | `skip` | `skip`: do not create a card while the previous one is still open; `allow`: create it anyway |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

**Calls** `POST /v1/boards/:boardId/schedules`

**Prints** JSON: the created schedule.

**Exit status** `0` on success. `1` when:

- `<boardId>`, `--title`, `--rule` or `--tz` is missing
- `--overlap` is not `skip` or `allow`
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi schedule add brd_8f2c… --title 'Weekly dependency audit' --rule 'weekly on mon at 09:00' --tz Europe/London
supi schedule add brd_8f2c… --title 'Triage inbox' --rule 'every 4 hours' --tz UTC --overlap skip
```

## `supi schedule rm`

Removes a schedule. Cards it already created are untouched.

```sh
supi schedule rm <boardId> <scheduleId>
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<scheduleId>` | the schedule (see `supi schedule list <boardId>`) |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

**Calls** `DELETE /v1/boards/:boardId/schedules/:scheduleId`

**Prints** `Deleted <scheduleId>.`; `--json` for `{ deleted }`.

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<scheduleId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi schedule rm brd_8f2c… sch_3a9d…
```

## `supi schedule pause`

Disables a schedule without removing it: it creates no cards until `schedule resume`.

```sh
supi schedule pause <boardId> <scheduleId>
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<scheduleId>` | the schedule (see `supi schedule list <boardId>`) |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

**Calls** `PATCH /v1/boards/:boardId/schedules/:scheduleId`

**Prints** JSON: the schedule.

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<scheduleId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi schedule pause brd_8f2c… sch_3a9d…
```

## `supi schedule resume`

Re-enables a paused schedule, so its rule creates cards again.

```sh
supi schedule resume <boardId> <scheduleId>
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<scheduleId>` | the schedule (see `supi schedule list <boardId>`) |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

**Calls** `PATCH /v1/boards/:boardId/schedules/:scheduleId`

**Prints** JSON: the schedule.

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<scheduleId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi schedule resume brd_8f2c… sch_3a9d…
```
