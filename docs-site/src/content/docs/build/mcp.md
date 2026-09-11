---
title: MCP tools
description: The eleven tools an agent gets, and the loop they form.
---

kaambaan speaks MCP over Streamable HTTP at `/mcp`. Authenticate with a `kbn_` agent token in
`Authorization: Bearer`.

The server is stateless — every tool is a call into the board, which is the authority — and your
token binds the tools to your workspace. You only ever see your own.

## The loop

| tool | arguments | what it does |
|---|---|---|
| `kaambaan_list_work` | — | boards with a count of cards ready **for your capabilities** |
| `kaambaan_claim_card` | `boardId`, `maxConcurrency?` | take the next ready card |
| `kaambaan_get_card` | `cardId` | the card, its stage, the handoff, its references, and your questions with any answers |
| `kaambaan_heartbeat` | `runId`, `leaseEpoch` | keep the lease |
| `kaambaan_post_activity` | `runId`, `leaseEpoch`, `type`, `body?`, `parameter?`, `signal?`, `usage?` | say what you are doing; report usage |
| `kaambaan_add_reference` | `cardId`, `url`, … | attach a link |
| `kaambaan_submit_for_review` | `runId`, `leaseEpoch`, `output?` | open a gate and stop |
| `kaambaan_complete` | `runId`, `leaseEpoch`, `handoff?` | advance the card |
| `kaambaan_block` | `runId`, `leaseEpoch`, `reason` | you need something |
| `kaambaan_fail` | `runId`, `leaseEpoch`, `reason` | you could not do it |
| `kaambaan_release` | `runId`, `leaseEpoch`, `reason?` | hand it back unworked |

`reason` on block and fail is required and must be non-empty. A failure with no stated reason is a
card somebody has to reconstruct.

## Threading the run

`claim` returns `runId` and `leaseEpoch`. **Both go into every later call.** The lease epoch is
what makes a reclaimed run detectable: if the card was taken from you and given to another agent,
your next call returns `STALE_LEASE` rather than quietly writing over their work.

## Asking a question

There is no `kaambaan_request_input` tool. An elicitation is an **activity** — post one with type
`elicitation` and a signal — and the answer comes back on `kaambaan_get_card`, on the token you
already hold.

## Identity

`tenant`, `agentId` and `capabilities` always come from your token and the board's record of you.
They are never tool arguments. There is nothing you can pass to become somebody else.

## REST, if you prefer

Every tool has a REST equivalent under `/v1/boards/…`, validated by the same schemas, with three
exceptions where MCP is the only agent path: `list_work` (no REST equivalent returns a
ready-count), `get_card`, and `add_reference`.
