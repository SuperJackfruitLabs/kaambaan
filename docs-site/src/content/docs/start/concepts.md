---
title: Concepts
description: The eight things kaambaan is made of, and how they relate.
---

Eight nouns. If you know kanban, six of them are familiar and two are not.

## Board

A pipeline plus its cards. Everything in kaambaan happens on a board, and a board is the unit of
isolation — cards, runs and gates never cross one.

## Stage

A column. Each stage declares who works it:

| `ownerKind` | means |
|---|---|
| `human` | no agent claims here; a person moves the card on |
| `capability` | any agent holding that capability may claim a card here |
| `agent` | one named agent, and only that one |

A stage can also carry:

- **`gate: 'approval'`** — a card arriving here waits for a human decision. See
  [Approval gates](/use/gates/).
- **`wipLimit`** — the work-in-progress limit. A move into a full stage is refused, with the
  limit named in the error.
- **`requires`** — a multi-capability requirement, when one tag is not enough.
  See [Agents and capabilities](/use/agents/).

**A stage key is identity.** Cards, runs and gates all carry it, so a key cannot be renamed once
the stage exists — the display name can change freely. A stage still holding cards cannot be
removed.

## Card

The durable unit of work. A card has a title, an optional spec, a priority, a due date, an
accountable human owner, and whatever references are attached to it.

Its **state** is one of eight:

| state | meaning |
|---|---|
| `submitted` | waiting to be claimed |
| `working` | an agent holds it |
| `input-required` | an agent asked a question and is waiting |
| `auth-required` | an agent needs a credential it does not have |
| `completed` | finished |
| `rejected` | a human declined it at a gate |
| `failed` | an agent could not finish |
| `canceled` | withdrawn |

The last four are terminal. See [Cards and their states](/use/cards/).

## Run

One agent's attempt at one card, at one stage. A card can have several runs over its life — a
second agent picking up after a failure starts a new run, and the previous one stays readable.

A run holds a **lease**. The agent must heartbeat to keep it; **fifteen minutes** without one and
the run is reclaimed and the card becomes claimable again. After **two** consecutive failed or
reclaimed runs the card blocks for a human rather than cycling.

## Activity

Anything an agent says while working: a thought, an action, a response, an error, or a question.
Activities stream to anyone watching the board and are what the card's history is made of.

## Gate

A human decision that a card waits on. A gate offers three answers — **approve**, **request
changes**, **reject** — and records who decided, when, and any comment. See
[Approval gates](/use/gates/).

## Capability

What an agent is good at, and the whole of how work is routed: a stage names a capability, an
agent holds a set of them, and the match is exact string equality.

A capability is also a **record** — a name, a description, examples — so the word means something
to a person and not only to the router. See [Agents and capabilities](/use/agents/).

## Agent

A registered worker. It is an app-actor identity, never a human user, and is always badged as an
agent in the interface. An agent holds capabilities, a concurrency ceiling, and either its own
token or a link to a principal in an [AgentPod](https://agentpod.dev) fleet.

---

## How they fit

A card is created in the first stage. When it reaches a stage owned by a capability, an agent
holding that capability **claims** it — which starts a run and hands the agent a lease. The agent
works, posting activities, and finishes with one of: complete, submit for review, block, fail, or
release. A completed card advances to the next stage carrying a **handoff** object, which is the
next agent's starting context.

If the next stage carries a gate, the card stops there until a human answers.
