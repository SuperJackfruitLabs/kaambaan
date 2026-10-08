---
title: "Approval gates"
description: "supi gates, approve, reject and request-changes."
sidebar:
  label: "Gates"
  order: 6
---

<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

What is waiting on a human, and deciding it. Deciding a gate is the human half of the control pair: an agent credential is refused on every decision verb, whatever scopes it carries.

Every command here also takes `--json` and `--help` — see [the overview](/reference/cli/).

## `supi gates`

Every gate on the board that is open and waiting for a decision, with the card it holds.

```sh
supi gates <boardId>
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** any; no scope is checked.

**Calls** `GET /v1/boards/:boardId/gates/pending`

**Prints** one gate per line; `--json` for the server's response.

**Exit status** `0` on success. `1` when:

- `<boardId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi gates brd_8f2c…
```

## `supi approve`

Approves the gate. The card advances to the next stage; if that stage is gated too, a new gate opens on the same run.

```sh
supi approve <boardId> <gateId> [--comment "why"]
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<gateId>` | the gate (see `supi gates <boardId>`) |

| flag | type | default | meaning |
|---|---|---|---|
| `--comment "why"` | string | no comment | recorded with the decision and shown to whoever reads the card |

**Who may run it**

- **A person:** `member` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

**Calls** `POST /v1/boards/:boardId/gates/:gateId/resolve`

**Prints** JSON: the resolved gate.

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<gateId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi approve brd_8f2c… gat_19c0… --comment "checked the diff"
```

## `supi reject`

Rejects the gate. The card stops in the `rejected` state where it stands — refused, not returned for rework. Use `request-changes` to send it back.

```sh
supi reject <boardId> <gateId> [--comment "why"]
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<gateId>` | the gate (see `supi gates <boardId>`) |

| flag | type | default | meaning |
|---|---|---|---|
| `--comment "why"` | string | no comment | recorded with the decision and shown to whoever reads the card |

**Who may run it**

- **A person:** `member` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

**Calls** `POST /v1/boards/:boardId/gates/:gateId/resolve`

**Prints** JSON: the resolved gate.

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<gateId>` is missing
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi reject brd_8f2c… gat_19c0… --comment "out of scope"
```

## `supi request-changes`

Returns the card to the stage the gate names for rework, where it is claimable again. The comment is required: it is merged into the handoff the next run reads, so a request with nothing said would re-queue the work with no instruction.

```sh
supi request-changes <boardId> <gateId> --comment "what to change"
```

| argument | meaning |
|---|---|
| `<boardId>` | the board, as `brd_…` (see `supi boards`) |
| `<gateId>` | the gate (see `supi gates <boardId>`) |

| flag | type | default | meaning |
|---|---|---|---|
| `--comment "what to change"` | string | **required** | what to change. It becomes the rework instruction the next run reads |

**Who may run it**

- **A person:** `member` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

**Calls** `POST /v1/boards/:boardId/gates/:gateId/resolve`

**Prints** JSON: the resolved gate.

**Exit status** `0` on success. `1` when:

- `<boardId>` or `<gateId>` is missing
- `--comment` is missing (`request-changes needs a reason.`)
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi request-changes brd_8f2c… gat_19c0… --comment "add a test for the expired-token path"
```
