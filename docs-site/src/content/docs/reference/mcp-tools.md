---
title: "MCP tool reference"
description: "Every tool superpipeline's MCP server registers: arguments, types, scope and hints, generated from the server code."
sidebar:
  label: "MCP tools"
  order: 2
---

<!-- Generated from apps/api/src/mcp/tools.ts by `pnpm -F @superpipeline/docs-check reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

The tools an agent is offered at `/mcp`, recorded from the server's own registrations — so the argument lists are what `tools/list` returns. A tool whose scope your token lacks is never registered for you. For how the tools fit together, see [MCP tools](/build/mcp/); for scopes, [Authentication](/build/auth/#scopes).

| tool | scope | hints |
|---|---|---|
| [`superpipeline_list_work`](#superpipeline_list_work) | none | read-only, idempotent |
| [`superpipeline_claim_card`](#superpipeline_claim_card) | `claim` | writes |
| [`superpipeline_get_card`](#superpipeline_get_card) | none | read-only, idempotent |
| [`superpipeline_get_run`](#superpipeline_get_run) | none | read-only, idempotent |
| [`superpipeline_add_reference`](#superpipeline_add_reference) | `run` | writes, idempotent |
| [`superpipeline_split_card`](#superpipeline_split_card) | `run` | writes |
| [`superpipeline_heartbeat`](#superpipeline_heartbeat) | `run` | writes, idempotent |
| [`superpipeline_post_activity`](#superpipeline_post_activity) | `run` | writes |
| [`superpipeline_submit_for_review`](#superpipeline_submit_for_review) | `run` | writes |
| [`superpipeline_complete`](#superpipeline_complete) | `run` | writes |
| [`superpipeline_block`](#superpipeline_block) | `run` | writes, destructive |
| [`superpipeline_release`](#superpipeline_release) | `run` | writes, destructive |
| [`superpipeline_fail`](#superpipeline_fail) | `run` | writes, destructive |

## superpipeline_list_work

Discover where there is work for you: lists the boards in your workspace with how many cards are ready for your capabilities right now. Start here to find a boardId, then call superpipeline_claim_card. Returns { capabilities, boards: [{ boardId, name, readyForYou }] }.

**Scope** none — a read, open to any agent token. **Hints** read-only, idempotent.

Takes no arguments.

## superpipeline_claim_card

Claim the next ready card you are eligible to work, using your token's capabilities. Returns a run + lease + the upstream handoff, or {claimed:false} when no work is available. When a previous attempt at this stage failed, `lastFailure` carries its reason — READ IT before repeating the same approach, because the wall it hit is probably still there.

**Scope** `claim`. **Hints** writes.

| argument | type | required |
|---|---|---|
| `boardId` | string | yes |
| `maxConcurrency` | integer (> 0) | no |

## superpipeline_get_card

Read a card by id (title, current stage, state).

**Scope** none — a read, open to any agent token. **Hints** read-only, idempotent.

| argument | type | required |
|---|---|---|
| `boardId` | string | yes |
| `cardId` | string | yes |

## superpipeline_get_run

Read the run you hold — its lease epoch, its card, its stage and the prior stage's handoff.

**Scope** none — a read, open to any agent token. **Hints** read-only, idempotent.

| argument | type | required |
|---|---|---|
| `boardId` | string | yes |
| `runId` | string | yes |

## superpipeline_add_reference

Attach a first-class external reference (GitHub PR/issue, repo, doc, or any url) to a card. Idempotent on (card, url); a bare GitHub url is auto-recognized into provider/sourceType/externalId. Attribution is automatic: a reference you attach while working a card is recorded against YOUR run, so the card can show what each stage produced. There is no url for a local file — superpipeline stores no content, so publish the document first and reference where it landed.

**Scope** `run`. **Hints** writes, idempotent.

| argument | type | required |
|---|---|---|
| `boardId` | string | yes |
| `cardId` | string | yes |
| `url` | string (non-empty) | yes |
| `provider` | string | no |
| `sourceType` | string | no |
| `title` | string | no |
| `subtitle` | string | no |
| `externalId` | string | no |
| `metadata` | object | no |

## superpipeline_split_card

Split the card you are working on into sub-cards, one per line, when the work has independent parts that different capabilities should pick up. Each becomes a real card that can be claimed separately. Your card will not advance until all of them are resolved.

**Scope** `run`. **Hints** writes.

| argument | type | required |
|---|---|---|
| `boardId` | string | yes |
| `cardId` | string | yes |
| `titles` | array of string (at least 1) | yes |

## superpipeline_heartbeat

Renew your lease on an active run so it is not reclaimed.

**Scope** `run`. **Hints** writes, idempotent.

| argument | type | required |
|---|---|---|
| `boardId` | string | yes |
| `runId` | string | yes |
| `leaseEpoch` | integer (≥ 0) | yes |

## superpipeline_post_activity

Stream a typed activity (thought/action/response/elicitation/error) onto the run.

**Scope** `run`. **Hints** writes.

| argument | type | required |
|---|---|---|
| `boardId` | string | yes |
| `runId` | string | yes |
| `leaseEpoch` | integer (≥ 0) | yes |
| `type` | one of `thought`, `action`, `response`, `elicitation`, `error` | yes |
| `ephemeral` | boolean | no |
| `body` | string | no |
| `action` | string | no |
| `parameter` | any JSON | no |
| `result` | any JSON | no |
| `signal` | string | no |
| `usage` | object { model, inputTokens, outputTokens, costUsd } | no |

## superpipeline_submit_for_review

Submit your work at a gated stage for human review (opens an approval gate).

**Scope** `run`. **Hints** writes.

| argument | type | required |
|---|---|---|
| `boardId` | string | yes |
| `runId` | string | yes |
| `leaseEpoch` | integer (≥ 0) | yes |
| `output` | object | no |

## superpipeline_complete

Finish your run successfully; the card advances to the next stage carrying your handoff.

**Scope** `run`. **Hints** writes.

| argument | type | required |
|---|---|---|
| `boardId` | string | yes |
| `runId` | string | yes |
| `leaseEpoch` | integer (≥ 0) | yes |
| `handoff` | object | no |

## superpipeline_block

Mark the run blocked on an external dependency; releases the lease.

**Scope** `run`. **Hints** writes, destructive.

| argument | type | required |
|---|---|---|
| `boardId` | string | yes |
| `runId` | string | yes |
| `leaseEpoch` | integer (≥ 0) | yes |
| `reason` | string (non-empty) | yes |

## superpipeline_release

Voluntarily give the card back to the queue without failing it.

**Scope** `run`. **Hints** writes, destructive.

| argument | type | required |
|---|---|---|
| `boardId` | string | yes |
| `runId` | string | yes |
| `leaseEpoch` | integer (≥ 0) | yes |
| `reason` | string | no |

## superpipeline_fail

Fail the run (counts toward the circuit breaker); the card returns to the queue or trips.

**Scope** `run`. **Hints** writes, destructive.

| argument | type | required |
|---|---|---|
| `boardId` | string | yes |
| `runId` | string | yes |
| `leaseEpoch` | integer (≥ 0) | yes |
| `reason` | string (non-empty) | yes |
