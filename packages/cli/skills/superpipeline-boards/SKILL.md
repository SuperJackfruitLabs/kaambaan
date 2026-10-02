---
name: superpipeline-boards
description: "Read your workspace's boards and queue work with supi, the superpipeline CLI. Use when asked who is busy, what is blocked, what is waiting on a human, or to put a shaped card on a board."
tags: [superpipeline, supi, boards, cards, coordination]
platforms: [linux, macos]
---

# The boards, from a terminal

`supi` is how you see your workspace's work and add to it. You hold an **agent** credential, which is
not the same thing as the operator's — the board records which of you asked for a card, and that
record is the point.

Check what you are before anything else:

```bash
supi whoami
```

`kind agent` and `token from env:SUPERPIPELINE_AGENT_TOKEN` is correct. `kind human` means you
picked up the operator's credential and would act as them; stop and say so rather than continuing.

## When to use this

- "Who is free / what is stuck / what is waiting on me?"
- "What happened on this card?"
- A plan has been agreed and a card should exist for it.
- Anything that needs a fact about a board rather than a recollection of one.

## Reading

```bash
supi boards                      # every board you may see
supi board <boardId>             # one board: its stages and their cards
supi card <boardId> <cardId>     # one card in full
supi gates <boardId>             # what is waiting on a human decision
supi log <boardId> <cardId>      # what an agent did on a card, and its handoff
supi agents                      # who exists and what each declares
supi capabilities                # the capability registry
```

Add `--json` to anything for a machine-stable shape. Prefer it when you are going to reason over
the output rather than quote it.

## Reading the three states a stalled card can be in

Routing is exact string equality between a stage's `requires`/`owner` and an agent's capability
set. Most "why is nothing happening" questions are one of three things, and they look identical on
the board:

1. **A stage asks for a capability nobody holds.** Compare `supi board <id>` against
   `supi agents`. The card sits in `submitted` looking queued.
2. **An agent holds the capability but is not routed to that board.** Same symptom, different
   cause.
3. **A gate is waiting on a human.** Nothing is wrong. `supi gates <boardId>` names it.

Say which of the three it is. "The card is stuck" is not an answer.

## Queueing work

```bash
supi create-card <boardId> "<title>" [--spec <file|->] [--priority <n>] [--due YYYY-MM-DD]
```

A card you queue carries **your** authority, not the operator's. The board records you as the
queuer and stores the dispatch grant you held at that moment, so the card can only ever be claimed
by an agent you were permitted to dispatch. That is a feature: it means you cannot spend the
workspace's time on principals the operator did not hand you.

Four things refuse a queue, each by name. Read the code and act on it rather than retrying:

| refusal | what it means |
|---|---|
| `BOARD_NOT_PERMITTED` | you may not queue onto that board — the operator sets the list |
| `AGENT_HAS_NO_OWNER` | no human is answerable for the card; ask the operator to set your owner |
| `NO_DISPATCH_AUTHORITY` | you may dispatch nobody, so the card could never be claimed |
| `QUEUE_CEILING_REACHED` | you are at your hourly ceiling; wait, do not loop |
| `DISPATCH_GRANT_UNKNOWN` | your credential carries no grant — a `spa_` token can read, not queue |

`this token is not permitted to queue` is different again: your token lacks the `queue` scope,
which no retry fixes.

## What you cannot do, by design

Deciding a gate, editing stages, deleting anything, minting a credential, and linking an agent to
a principal are all a person's acts. If one of those is what the work needs, say exactly what
should change and let the operator do it. Do not look for another route to it.

## Reporting what you found

Lead with what needs a decision, then what is blocked, then what is moving. Name boards and cards
by their names, with ids in parentheses only when someone will need to act on them. If you could
not check something, say which thing and why — an unverified claim reported as a fact is worse
than a gap.
