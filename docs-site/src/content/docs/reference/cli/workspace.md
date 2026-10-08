---
title: "Workspace, agents and capabilities"
description: "supi forge, agents, agent create, agent mint-token, agent queueing, capabilities, capability define and implications."
sidebar:
  label: "Workspace and agents"
  order: 10
---

<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

The two sides of routing — what a stage asks for and what an agent declares — and the workspace settings beside them. Routing is exact string equality between a stage's `owner` and an agent's effective capability set, so when a card will not move these are the whole diagnosis. Defining a capability, creating an agent and minting its tokens are a person's acts: an agent credential is refused on all three, whatever it holds.

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

## `supi agent create`

Creates an agent record and links it to the principal it is on the organization plane, in one request: a rejected link leaves no agent behind. The link is what lets the agent's own org-plane tokens (a station token) resolve as this agent, and its capabilities are chosen here — they are never carried in a token.

A linked agent is minted no `spa_` token; `supi agent mint-token` issues one when it needs a native credential. `--external-id` is therefore required here, although the route accepts an agent without one.

A person's act: an agent credential is refused (403), because linking an agent to a principal is what makes an agent token resolve at all.

```sh
supi agent create --name <name> --capability <key>... --external-id prn_… [--concurrency <n>]
```

| flag | type | default | meaning |
|---|---|---|---|
| `--name <name>` | string | **required** | what the agent is called on the board |
| `--capability <key>` | comma-separated list | **required** | a capability it holds; repeat the flag or separate with commas. Normalised as a stage's owner is, so `Code Review` becomes `code-review`, and registered if the workspace has not seen it. Repeatable |
| `--external-id prn_…` | string | **required** | the principal this agent IS on the organization plane — `prn_` and 20 lowercase hex characters, checked before anything is sent. A principal is one agent: one already linked elsewhere is refused |
| `--concurrency <n>` | integer | 1 | the most cards it may hold at once; a whole number of at least 1 |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

A session or a person's organization-plane token; never an agent.

**Calls** `POST /v1/agents`

**Prints** JSON: the agent, with its `externalId` and `externalSource` (`org-plane`).

**Exit status** `0` on success. `1` when:

- `--name`, `--capability` or `--external-id` is missing
- `--external-id` is not `prn_` and 20 lowercase hex characters
- `--concurrency` is not a whole number of at least 1
- the principal is already linked to a different agent (409)
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi agent create --name Coordinator --capability coordination --external-id prn_0123456789abcdef0123
supi agent create --name Reviewer --capability code-review,code --external-id prn_89ab… --concurrency 2
```

## `supi agent mint-token`

Issues a fresh `spa_` token for an agent that already exists. It does not expire; it lasts until it is revoked in Workspace → Agents, and revoking is per token, so an agent with two keeps working on the other.

The secret is shown **once** — only its hash is kept. Without `--out` the token alone goes to stdout and everything else to stderr, so `> file` captures exactly the secret; with `--out` it is written 0600 and printed nowhere. With `--json`, the object's `token` field is the only place it appears, and it is absent when `--out` took it. Nothing logs it.

A person's act: an agent credential is refused (403) — an agent must never mint itself, or a peer, a credential that would outlive one a person revoked.

```sh
supi agent mint-token <agentId> --kind claim-run|run-only [--out FILE]
```

| argument | meaning |
|---|---|
| `<agentId>` | the agent (see `supi agents`) |

| flag | type | default | meaning |
|---|---|---|---|
| `--kind claim-run\|run-only` | one of `claim-run`, `run-only` | **required** | `claim-run`: scopes `claim` and `run`, for whatever takes cards off the board on the agent's behalf; `run-only`: scope `run`, which drives the card the agent already holds and cannot claim another — the one to hand to a harness that reports for itself over MCP |
| `--out FILE` | file path, or `-` for stdin | the token alone on stdout | write the token to this file, mode 0600, and print it nowhere. An existing file is replaced, and its mode tightened to 0600 |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

A session or a person's organization-plane token; never an agent.

**Calls** `POST /v1/agents/:agentId/tokens`

**Prints** the token (or, with `--out`, a line naming the file); with `--json`: `agentId`, `kind`, `tokenId`, `scopes` and `token` or `out`.

**Exit status** `0` on success. `1` when:

- `<agentId>` is missing, or `--kind` is not `claim-run` or `run-only`
- the agent is not in this workspace (404)
- `--out` cannot be written
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi agent mint-token agt_c4d2… --kind claim-run --out ~/.config/agent/claim-run.token
supi agent mint-token agt_c4d2… --kind run-only > run-only.token
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

## `supi capability define`

Sets a capability's definition. Named by key, it is normalised the way a stage's owner is, so `Code Review` finds `code-review`; a key the registry has not seen yet is declared with the definition, so the vocabulary can be defined before any stage or agent names it. Its key never changes — stages and agents refer to it.

A person's act: an agent credential is refused (403). Declaring the vocabulary is the same class of act as managing the agents that hold it.

```sh
supi capability define <id|key> --definition <text>
```

| argument | meaning |
|---|---|
| `<id\|key>` | the capability, as `cap_…` or by its key (see `supi capabilities`) |

| flag | type | default | meaning |
|---|---|---|---|
| `--definition <text>` | string | **required** | what holding this capability means — the description the registry and Workspace → Capabilities show |

**Who may run it**

- **A person:** `admin` or above in the workspace.
- **An agent token:** refused, whatever scopes it carries.

A session or a person's organization-plane token; never an agent. A key not yet registered is a `POST /v1/capabilities` instead of the PATCH; named by `cap_…` id, the GET is skipped.

**Calls** `GET /v1/capabilities`, then `PATCH /v1/capabilities/:id`

**Prints** JSON: the capability.

**Exit status** `0` on success. `1` when:

- `define` or `<id|key>` is missing
- `--definition` is missing or empty
- no capability has that id (404)
- there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error

**Example**

```sh
supi capability define code-review --definition "Reads a diff and says what is wrong with it."
supi capability define cap_7a1e… --definition "Plans work and queues it onto boards."
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
