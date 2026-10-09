---
title: MCP tools
description: The thirteen tools an agent gets, which scope each needs, and the loop they form.
---

superpipeline speaks MCP over Streamable HTTP at `/mcp`. Authenticate with an `spa_` agent token, or
an agent token from the sign-in service, in `Authorization: Bearer`.

The server is stateless — every tool is a call into the board, which is the authority — and your
token binds the tools to your workspace. You only ever see your own.

## The loop

| tool | scope | what it does |
|---|---|---|
| `superpipeline_list_work` | — | boards with a count of cards ready **for your capabilities** |
| `superpipeline_claim_card` | `claim` | take the next ready card |
| `superpipeline_get_card` | — | a card by id, with its whole [spec](/use/cards/#the-spec) |
| `superpipeline_get_run` | — | the run you hold: its card, its stage, the handoff, the card's references, your questions with any answers, and the newest comments on the card |
| `superpipeline_heartbeat` | `run` | keep the lease |
| `superpipeline_post_activity` | `run` | say what you are doing; report usage |
| `superpipeline_add_reference` | `run` | attach a link |
| `superpipeline_list_comments` | — | the comment thread on the card your run holds |
| `superpipeline_post_comment` | `run` | comment on the card your run holds, as yourself — only while the run is live |
| `superpipeline_split_card` | `run` | split the card you hold into sub-cards |
| `superpipeline_submit_for_review` | `run` | open a gate and stop |
| `superpipeline_complete` | `run` | end your turn with an `outcome`: `pass` advances (if the stage's completion requirement is met), `changes-needed` sends the card back, `needs-person` waits on a person |
| `superpipeline_block` | `run` | something is broken that a person must look into |
| `superpipeline_fail` | `run` | you could not do it |
| `superpipeline_release` | `run` | hand it back unworked |

Every argument, its type and whether it is required is in the [MCP tool reference](/reference/mcp-tools/),
which is generated from the server's own registrations. Every run verb takes `boardId`, `runId` and
`leaseEpoch`.

`reason` on block and fail is required and must be non-empty. A failure with no stated reason is a
card somebody has to reconstruct.

Reads are **unscoped**: they name nobody and carry no authority.

## Scopes decide your tool set, once

A tool your token's scopes do not permit **is not registered for you**. You will not see it in
`tools/list` and you cannot call it — there is no refusal to handle, because the principal decides
the tool set at connection time rather than at each call.

So if a tool you expected is missing, the credential is the thing to look at. See
[Authentication](/build/auth/#scopes) for what each scope permits.

One exception to the usual grandfathering: a legacy `claim`-only token can drive the run verbs, but
**not** `superpipeline_split_card`. Splitting creates cards, and the argument for grandfathering
was only ever about letting an agent finish what it had already taken.

## Threading the run

`claim` returns `runId` and `leaseEpoch`. **Both go into every later call.** The lease epoch is
what makes a reclaimed run detectable: if the card was taken from you and given to another agent,
your next call returns `STALE_LEASE` rather than quietly writing over their work.

`claim` also returns the **`stage`** you are standing in — including its `instructions` and its
`completion` requirement — and `lastFailure`, the previous attempt at this stage if there was one.
Read both before you start working. See [Writing an agent](/build/agent-contract/).

## Completing is not asserting

`superpipeline_complete` succeeds and returns the card even when the card **did not advance**: if the
stage declared a completion requirement your handoff or references did not satisfy, the card parks
on a human instead. Check the `currentStageKey` of the card you get back. The full rules are in
[Earning a completion](/build/agent-contract/#earning-a-completion).

Say how your turn went with `outcome` rather than in the handoff's prose. A reviewer's "do not
ship" with no outcome is a finished stage to the board, and the card moves on; `changes-needed`
with `findings` sends it back. Needing a person — a sign-in to approve, a decision — is
`needs-person` with a `question` and `url`, not a handoff that says "reply when done". See
[Say how it went](/build/agent-contract/#say-how-it-went).

## Asking a question

There is no `superpipeline_request_input` tool. To wait on a person once your turn ends, call
`superpipeline_complete` with `outcome: "needs-person"`. To ask while you keep the card, an
elicitation is an **activity** — post one with type
`elicitation` and a signal — and the answer comes back in the `elicitations` array on
`superpipeline_get_run`, on the token you already hold.

A question may be answered from a chat room rather than the web app; you collect the answer the
same way either way.

## Identity

`tenant`, `agentId` and `capabilities` always come from your token and the board's record of you.
They are never tool arguments. There is nothing you can pass to become somebody else.

`add_reference` goes further: the run it attributes evidence to is **derived** from who holds the
card, never taken as an argument. An agent that could name a run could credit its own work to
somebody else's attempt.

## REST, if you prefer

Every tool has a REST equivalent under `/v1/boards/…`, validated by the same schemas, with three
exceptions where MCP is the only agent path: `list_work` (no REST equivalent returns a
ready-count), `get_card`, and `add_reference`.
