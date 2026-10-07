---
title: "Workspace, agents and capabilities"
description: "supi forge, agents, agent queueing, capabilities and implications."
sidebar:
  label: "Workspace and agents"
  order: 10
---

<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

The two sides of routing — what a stage asks for and what an agent declares — and the workspace settings beside them. Routing is exact string equality between a stage's `owner` and an agent's effective capability set, so when a card will not move these are the whole diagnosis.

Every command here also takes `--json` and `--help` — see [the overview](/reference/cli/).

## `supi forge`

Shows or sets the workspace's forge host. GitHub needs no configuration; a self-hosted Forgejo does, and until it is set a link to one of its repositories is stored as a plain URL — with no durable id for events to match.

```sh
supi forge [<host>|none]
```

| argument | meaning |
|---|---|
| `<host\|none>` | a Forgejo host to set, or `none` to clear it; omit to show the current one (optional) |

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

Showing needs `viewer`; setting or clearing needs `admin`.

**Calls** `GET /v1/tenant/forge`, then `PUT /v1/tenant/forge`

**Prints** `forge <host>`, `No forge configured.` or `Forge cleared.`; `--json` for `{ forgeHost }`.

**Exit status** `0` on success. `1` when:

- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi forge
supi forge git.example.com
supi forge none
```

## `supi agents`

Every agent in the workspace with the capabilities it declares, its token ids (never a token) and its queueing policy.

```sh
supi agents
```

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** the `read` scope.

**Calls** `GET /v1/agents`

**Prints** JSON: the agents.

**Exit status** `0` on success. `1` when:

- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi agents
```

## `supi agent queueing`

Sets the three bounds on an agent that queues work of its own. At least one flag is required; a flag left out is left unchanged, and clearing is always typed (`none`), never inferred from an empty value. The dispatch grant itself is not set here — it arrives in the agent's token from the fleet that issued it.

```sh
supi agent queueing <agentId> [--owner <userId>|none] [--boards <id,id,…>|none] [--ceiling <n>]
```

| argument | meaning |
|---|---|
| `<agentId>` | the agent (see `supi agents`) |

| flag | type | default | meaning |
|---|---|---|---|
| `--owner <userId>\|none` | string | unchanged | the person whose work the agent's own cards are; `none` clears it |
| `--boards <id,id,…>\|none` | comma-separated list | unchanged | the boards the agent may queue onto, comma-separated. `none` — which is also every agent's starting state — means NO board, not every board |
| `--ceiling <n>` | integer | unchanged | the most cards it may queue in an hour; a whole number of at least 1 |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

**Calls** `PATCH /v1/agents/:agentId`

**Prints** JSON: the agent.

**Exit status** `0` on success. `1` when:

- `<agentId>` is missing, or the sub-verb is not `queueing`
- no flag is given
- `--ceiling` is not a whole number of at least 1
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi agent queueing agt_c4d2… --owner usr_19a0… --boards brd_8f2c…,brd_93fa… --ceiling 6
supi agent queueing agt_c4d2… --boards none
```

## `supi capabilities`

Every capability the workspace knows, and where each came from — declared by a person, or inferred because a stage asked for it. A capability a stage names and no agent holds is a lane nothing can claim.

```sh
supi capabilities
```

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** the `read` scope.

**Calls** `GET /v1/capabilities`

**Prints** JSON: the capabilities.

**Exit status** `0` on success. `1` when:

- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi capabilities
```

## `supi implications`

The implication edges between capabilities. An agent's effective capability set is what it declares plus everything those imply, and routing compares a stage's owner against that set.

```sh
supi implications
```

**Who may run it**

- **A person:** `viewer` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

Not open to agent tokens today.

**Calls** `GET /v1/capabilities/implications`

**Prints** JSON: the edges.

**Exit status** `0` on success. `1` when:

- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi implications
```
