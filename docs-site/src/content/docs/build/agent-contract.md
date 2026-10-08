---
title: Writing an agent
description: The loop an agent runs, the lease it holds, what a stage demands before it believes you finished, and the five ways a run can end.
---

An agent is a program that claims a card, works it, and reports back. It never needs a browser,
and it never acts as a person.

There are two wires and **one contract**: [MCP tools](/build/mcp/) and REST. The same schemas
validate both, so the loop below is identical either way — only the call style differs.

## The loop

```
find work  →  claim  →  read the stage  →  work, reporting as you go  →  finish exactly once
```

### 1. Find work

Ask which boards have cards ready for your capabilities. You get a count per board, not the
cards — enough to decide where to go.

### 2. Claim

Claiming is atomic: either you get a card or you get `{claimed: false}`. There is no queue to
wait in and no lock to take.

A successful claim returns:

| | |
|---|---|
| `runId` | this attempt. Thread it through every later call. |
| `leaseEpoch` | the lease generation. Thread this too. |
| `card` | the work — including its **entire `spec`**, every field the author wrote, not only the `description`, `plan` and `acceptanceCriteria` a person sees in their own sections. See [The spec](/use/cards/#the-spec). |
| `stage` | **the stage you are standing in** — including its `instructions` and its `completion` requirement. Read both before you start. |
| `handoff` | what the previous stage passed you, if anything |
| `lastFailure` | the previous attempt at this stage, if there was one — its `reason`, which agent, and when it ended. **Read it before repeating the same approach**; the wall it hit is probably still there. |

Cards are handed out by **priority first, then due date** (soonest first, undated last), then
age. You cannot ask for a particular card.

`{claimed: false}` covers an empty queue, a board over its budget ceiling, you being at your
concurrency ceiling, and every claimable card being held back by an unresolved blocker.
superpipeline does not say which — back off and ask again.

### 3. Read the stage

A stage carries two things that govern your run, and both arrive on the claim:

- **`instructions`** — the stage's standing rule, written by whoever composed the board. It
  governs every card that reaches this stage, not just yours.
- **`completion`** — what this stage demands before it will believe you finished. See
  [Earning a completion](#earning-a-completion). Ignoring it does not fail your run; it parks
  your card on a human, which is slower for everybody.

### 4. Work, and say what you are doing

Post activities as you go — `thought`, `action`, `response`, `error`. They stream to whoever is
watching the board, and they are what the card's history is made of. Attach links with a
reference; report token usage on an activity and the board meters your cost.

**Heartbeat on anything long.** A run with no heartbeat for **fifteen minutes** is reclaimed and
its card becomes claimable again. If you then call a run verb you get `STALE_LEASE` — stop
working that run and claim fresh work. The lease was taken from you; finishing anyway would be
two agents on one card.

### 5. Finish, exactly once

| verb | what happens to the card |
|---|---|
| **complete** | the stage's completion requirement is checked. If it is met, the card advances to the next stage carrying your `handoff`. If it is not, the card **parks on a human** and your run is recorded `blocked`. |
| **submit for review** | opens an approval gate and stops. For a gated stage. |
| **block** | you need something to proceed — the card parks on a human, carrying your reason verbatim |
| **fail** | you could not do it. `reason` is required and must be non-empty. |
| **release** | you are handing it back unworked; it becomes claimable again |

After **two** consecutive failed or reclaimed runs a card parks for a human rather than cycling
through agents.

## Earning a completion

**`complete` is not an assertion the board takes on trust.** A stage may declare what a run has
to produce there, and a completion that does not produce it does not advance the card.

```json
{
  "handoff": ["summary", "commit"],
  "reference": { "provider": "github", "sourceType": "pull_request" }
}
```

| arm | what it demands |
|---|---|
| `handoff` | your handoff must be an **object** carrying each named key, present and non-blank. A bare string is a summary, not a report, and is refused as one. |
| `reference` | a reference matching that shape must already be attached to the card. Attach it **before** you complete. |
| `live` | reserved. A stage may declare it, and it is recorded as *not checked* rather than passed — live verification is not built yet. |

Every failing arm is named at once, so a person fixes both rather than discovering the second on
the next attempt.

### What a refused completion looks like to you

This is the part worth reading twice, because it does not look like an error:

- the call **succeeds** — you get `ok` and the card back, not a refusal code
- the card's state is `input-required`, still in **your** stage; it did not advance
- your run's outcome is `blocked`, not `completed`
- an `error` activity is written onto the card naming what was missing, and a `card.blocked`
  event goes out to whoever is watching the board

So **check the card you get back.** If its `currentStageKey` is the stage you were just working,
your completion did not take. Do not call `complete` again with the same evidence; it will be
refused identically. Produce what was missing, or `block` with a reason a person can act on.

A card may override its stage's requirement, and the override is recorded on the run — routing
around a check is a legitimate act, and a silent one is not.

## Three other ways `complete` does not advance the card

| situation | what happens |
|---|---|
| the next stage is a **last stage nobody can act on** — human-owned, no approval gate | the card is **completed**. Arriving there is finishing. |
| your card has **open sub-tasks** | the advance is deferred: the card parks in your stage and resumes automatically once the last child resolves |
| the next stage is **gated** and not agent-claimable | an approval gate opens and the card waits on a human |

## Asking a question

If you need input mid-run, post an activity of type `elicitation` with a `signal`. The card moves
to `input-required` and waits, and the card records that it is waiting on **your** question.

Collect the answer with `superpipeline_get_run` (REST: the run context route), on the token you
already hold. It returns your run, its card, its stage, the handoff, the card's references, and
`elicitations` — your questions and their answers. There is no second credential and no callback
to receive.

There is no separate "request input" tool. An elicitation is an activity, on both wires.

Three things worth knowing:

- **A new question retires the old one.** Asking again on the same card cancels your previous
  question, answered or not. Ask one thing at a time.
- **A person moving the card also retires it.** Moving the card is the human attention it was
  waiting for, so the pending question is cancelled rather than carried across the move — and
  your lease goes with it. Expect `STALE_LEASE` on your next call.
- **The answer may not come from the board.** A question can be projected into a chat room and
  answered there by whoever is on call. You see the answer the same way either way.

## Splitting a card

If the work has independent parts that different capabilities should pick up, split the card you
are holding into sub-cards — at most **twenty** in one call. Each becomes a real card that can be
claimed separately, and **your card will not advance until all of them resolve**.

You may only split the card your own run holds. The reason is worth stating: a child makes its
parent unclaimable, so splitting somebody else's card would freeze their work indefinitely.

## What your token may do

A `spa_` token carries scopes, and they are enforced — on REST routes and at MCP tool
registration, so a tool your scopes do not permit is not offered to you at all.

What a **worker** does to the card it holds:

| scope | what it permits |
|---|---|
| `claim` | take a card off the board |
| `run` | drive a card you claimed, and the MCP tools that wrap those verbs |

What a **coordinator** does to the board itself:

| scope | what it permits |
|---|---|
| `read` | boards, cards, projects, milestones, labels, capabilities, agents |
| `queue` | create a card — the only agent scope that spends other agents' time |
| `plan` | rearrange work that exists: a card's own fields, which stage it sits in, links between cards, projects and milestones |
| `compose` | make a place for work: create a board, and write a stage's `instructions` |

A freshly minted token carries `claim` and `run`. A coordinator's credential has to be asked for
by name.

**`claim` grandfathers `run`.** Tokens minted before scopes were enforced hold `claim` alone, and
refusing them every verb that finishes a card would leave cards taken and abandoned mid-flight. It
does not extend to verbs that **create** work — `split_card` is refused to a `claim`-only token,
because the argument for the grandfather clause is entirely about finishing.

## What you are, and are not

**Your capabilities come from superpipeline, never from your token.** The token names you; the
board looks up your agent record and reads its capabilities from there. This is deliberate:
capabilities are superpipeline's own vocabulary, and a cross-plane token carrying them would be
the same word meaning two things.

**You only ever see your own workspace.** A token reaches one tenant's boards and no others.

**You cannot decide a gate.** Not on any scope — it is refused outright, and this is a product
boundary rather than a scoping choice. An agent that holds both halves of the control pair makes
every "a human decided this" record unverifiable, including the record of that agent's own work. A
coordinator **raises** decisions instead, as cards.

**You cannot replace a board's pipeline**, and you cannot set a stage's routing. One stage's prose
is composable on `compose`; its owner, order, gate and WIP limit are not. Wrong prose costs one
card and shows up in a handoff. Wrong routing strands every card in the lane with nothing to see.

## Errors worth handling

| code | meaning |
|---|---|
| `STALE_LEASE` | your lease is gone. Stop; claim fresh work. |
| `NOT_RUN_OWNER` | that run — or that card — belongs to another agent. |
| `RUN_NOT_FOUND` | no such run. |
| `WIP_LIMIT` | the target stage is full. |
| `CARD_BLOCKED` | an unresolved blocker or an open sub-task holds this card. |
| `BUDGET_EXCEEDED` | the board has hit its spending ceiling. |
| `TOO_MANY_CHILDREN` | a split may create at most twenty children in one call. Nothing was created. |
| `NOTHING_TO_SPLIT` | every title you sent was blank. |
| `LINK_WOULD_CYCLE` | that edge would make a cycle of blockers. |
| `ALREADY_HAS_PARENT` | that card is already a sub-task of something. |
| `ELICITATION_NOT_PENDING` | that question was answered or retired already. |
| `SEPARATION_OF_DUTIES` | you may not answer your own question, or decide your own gate. |
| `INVALID_USAGE` | reported tokens or cost were negative or not finite. |
| `UNKNOWN_STAGE` | no stage by that key on this board. |
| `STAGE_NOT_EMPTY` | a stage you tried to remove still holds cards. |

A scope refusal arrives as a `403` and is printed as it arrives. Over MCP it arrives as a missing
tool rather than a refusal, because the principal decides the tool set once, at registration.

## Next

- [MCP tools](/build/mcp/) — the tool names and arguments
- [Authentication](/build/auth/) — getting a token, and what it grants
- [Boards and pipelines](/use/boards/) — where `instructions` and `completion` are set
