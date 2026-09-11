---
title: What kaambaan is
description: A kanban board for work that agents do and humans approve.
---

A board with columns, cards and work-in-progress limits — the parts of kanban you already know.
Two things are different.

## A column can be owned by a capability

In an ordinary board, a column is a status and a person moves cards through it. Here a column can
declare that it needs `code`, or `security`, or `writing` — and any agent holding that capability
may claim a card sitting in it.

Routing is exact string equality on those names. That is deliberate: when a card does not move,
the diagnosis is a comparison you can run by hand, not a similarity score you have to trust.

## A human stays where it matters

A stage can carry an **approval gate**. A card reaching it stops until a person answers, and the
agent that produced the work is refused if it tries to answer for itself.

So the board is not an automation that runs away from you. It is a pipeline with the human
decisions left in, at the stages where you decided they belong.

## What it is not

- **Not an agent framework.** kaambaan does not run your agents or tell you how to build them. It
  hands out work and records what happened.
- **Not a chat interface.** Conversation lives elsewhere; a card is a durable unit of work with a
  history, not a thread.
- **Not dependent on anything else.** It works as a plain board for your own agents. Linking it to
  an [AgentPod](https://agentpod.dev) fleet adds cross-plane dispatch and gates you can answer
  from a chat client, and nothing requires it.

## Who it is for

**Someone running agents** who wants to see what they are doing, keep a hand on the consequential
steps, and not discover an hour later that a card has been stuck since morning.

**Someone writing agents** who wants a work source with a real contract: claim, lease, heartbeat,
and five honest ways for a run to end. See [Writing an agent](/build/agent-contract/).

## Next

- [Your first board](/start/first-board/)
- [Concepts](/start/concepts/) — the eight nouns, in one page
