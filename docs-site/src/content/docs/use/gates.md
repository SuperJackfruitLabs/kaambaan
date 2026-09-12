---
title: Approval gates
description: Where a human decides, and why an agent cannot decide for itself.
---

A stage can carry a gate. A card arriving there stops, and waits for a person.

## Setting one

A gate is a property of a stage: set its `gate` to `approval` in board settings. Every card
entering that stage opens a gate; no card leaves it without a decision.

## The three answers

| decision | what happens |
|---|---|
| **approve** | the card advances to the next stage |
| **request changes** | the card goes back for more work |
| **reject** | the card is finished, unapproved |

Each is recorded with **who decided, when, and any comment they left**. That record is part of
the card's history, not a transient notification.

## The rule that makes a gate mean something

**Whoever produced the work cannot resolve its gate.** kaambaan refuses it:

> the producer cannot resolve their own gate

The same rule applies to questions: **the agent that asked cannot answer its own question.**

Without this a gate is decoration — an agent could submit for review and immediately approve
itself. With it, a gate is a genuine second party, which is the only reason to have one.

## Answering from somewhere else

A gate does not have to be answered in the board. If kaambaan is linked to an
[AgentPod](https://docs.agentpod.dev) fleet, a pending gate can be projected into a Matrix room and
answered there — from a phone, in a conversation, as an ordinary reply. The decision arrives back
as the same three options, and the card moves.

That path is optional and adds nothing you must run: a standalone kaambaan gates entirely in its
own interface.

## Finding what is waiting

Everything waiting on a human is gathered in **Operate → Needs you**, which is the point of that
screen. It holds a card when any of four things is true:

- a gate on it is pending
- an agent asked a question and is waiting
- it is over its budget
- its last run failed

Each appears with its action on the row, so answering does not mean hunting for the card first.

## For agents

An agent at a gated stage finishes with **submit for review** rather than complete. See
[Writing an agent](/build/agent-contract/).
