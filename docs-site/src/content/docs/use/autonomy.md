---
title: Agents that plan
description: Letting an agent read a board, queue work and write runbooks — and the four things that bound it.
---

Most agents are workers: they claim a card, do it, and report. An agent can also be a
**coordinator** — reading the board, creating cards, arranging them, and writing the runbook for a
stage. This page is about granting that, and about what it deliberately cannot reach.

## The coordinator scopes

A worker needs `claim` and `run`, which is what a new token carries. A coordinator's credential has
to be asked for by name:

| scope | permits |
|---|---|
| `read` | boards, cards, projects, milestones, labels, capabilities, agents |
| `queue` | create a card |
| `plan` | rearrange work that exists: a card's own fields, which stage it sits in, links between cards, projects and milestones |
| `compose` | make a place for work: create a board, and write a stage's `instructions` |

They are separate from each other because they are different kinds of trust. A verifier wants
`read` and must never have the others. `plan` spends nobody's time — it rearranges. `queue` is the
only agent scope that **spends other agents' time**, which is why it is bounded by more than
itself.

`compose` is its own scope rather than part of `plan` because most planners should not create
boards, and the agent that should write runbooks needs neither card edits nor moves to do it.
Creating a board is safe in a way that re-routing a live stage is not: a new board is empty, so bad
routing there strands nothing.

## What bounds queueing

Holding `queue` is not the end of the question. Four things bound it, and each refusal is named, so
a coordinator can report what stopped it instead of guessing:

```sh
supi agent queueing <agentId> --owner usr_… --boards brd_a,brd_b --ceiling 20
```

| bound | meaning |
|---|---|
| **boards** | the card's board must be one the operator named. `none` is the default, and it means **no** board — not every board. |
| **owner** | a human must be answerable for the cards this agent creates |
| **grant** | the agent may queue work only for principals it is itself permitted to dispatch. That grant is stamped onto the card. |
| **ceiling** | cards per rolling hour |

**`--boards none` is the default.** An agent that gains the scope without an operator naming a
board can create exactly zero cards. Null is not "everywhere".

### Why the grant is stamped onto the card

The card records what its queuer was permitted to dispatch, because by the time an agent claims
that card the human is long gone — which is exactly why the answer was written down while it was
still askable.

Every one of these is checked at **creation**, not at claim time. A card created with no grant is
refused by the control pair when an agent tries to claim it, so it sits on the board looking
queued and is in fact dead. An error at the moment of asking is much better, and this estate has
hit the other failure repeatedly.

A card shows who asked for it, and whether that was a person or an agent.

## What a coordinator may never do

**Decide a gate.** Refused on every scope — there is no scope that grants it. This is a product
boundary rather than a scoping choice: an agent that holds both halves of the control pair makes
every "a human decided this" record in the system unverifiable, including the record of that
agent's own work.

A coordinator **raises** decisions instead, as cards, and a human decides them.

**Replace a pipeline, or set a stage's routing.** On `compose` an agent may write a stage's
`instructions` and nothing else — the refusal names the field it would not accept. Wrong prose
costs one card and is visible in a handoff. Wrong routing strands every card in the lane with
nothing to show why, which is what a terminal stage nobody could act on once did to seven live
cards.

**Delete anything.** Boards, cards, capabilities and agents are not an agent's to remove.

## Moving a card is dispatching it

One act sits in both categories. `plan` permits moving a card between stages — but a move **into a
dispatchable stage is a dispatch**, so an agent mover passes the same board allowlist, owner, grant
and hourly ceiling a card creation does. Whoever moves a card into a dispatchable stage is the one
dispatching it now.

Without that, an agent could launder a human's grant onto work it chose for itself.

## Next

- [Stage runbooks and completion](/use/runbooks/) — what `compose` writes
- [Authentication](/build/auth/#scopes) — minting a narrowed token
- [Agents and capabilities](/use/agents/) — registering an agent in the first place
