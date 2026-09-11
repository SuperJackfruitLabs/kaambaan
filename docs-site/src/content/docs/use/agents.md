---
title: Agents and capabilities
description: How work finds an agent, and how to tell when it cannot.
---

## Routing, in one sentence

A stage names a capability; an agent holds a set of them; a card is claimable by an agent whose
set contains the stage's. The comparison is **exact string equality**.

That is a deliberate choice, not a simplification waiting to be improved. When a card does not
move, the diagnosis is a string comparison anybody can run by hand. A similarity score would make
the same failure unfalsifiable.

The practical consequence: **`code review`, `code-review` and `Code Review` are three different
capabilities.** kaambaan normalises what you type to one spelling on the way in, at every place a
capability can be written, so you mostly do not have to think about it — but two agents typed
into two different products will not match unless the spelling agrees.

## When one capability is not enough

A stage can require a set:

- **all** — the agent must hold every one. A lane needing somebody who can write code *and*
  assess security.
- **any** — holding one is enough. A lane that either a Python or a TypeScript agent can work.

Both may be present, and both bind.

## Implication

A workspace can declare that holding one capability means holding another — `code-review` implies
`code`. An agent's **declared** set is what you typed; its **effective** set is the closure over
those declarations, and routing matches the effective one.

This is how you rename or reorganise a vocabulary without restaffing every agent. Routing stays
exact equality; the implications are what widen the set, not a fuzzy match.

## The capability registry

A capability is more than a string in two places. Each has a record: a name, a description,
examples, tags, and where it came from —

- **declared** — somebody defined it deliberately
- **inferred** — it turned up in use and was registered on first sight

That distinction answers a question you cannot otherwise ask: *which of these did nobody ever mean
to create?* A typo registers as `inferred` and sits there looking exactly like a typo.

### The two diagnostics

**Workspace → Capabilities** counts, per capability, how many agents hold it and how many boards
ask for it. Two states are worth acting on:

| state | what it means |
|---|---|
| held by agents, asked for by no stage | those agents can claim nothing with it |
| asked for by a stage, held by no agent | that lane will hold cards nothing can claim |

The first is the one that bites, because everything looks staffed until you notice the count.

## Concurrency

Each agent has a ceiling on simultaneous claimed cards. An agent may ask for fewer at claim time —
a busy worker throttling itself — but never more: **the request is a preference, the setting is the
permission.**

The count is per board.

## Linked agents

If your workspace is linked to an [AgentPod](https://agentpod.dev) fleet, an agent can be added
straight from it: kaambaan reads the agents you may dispatch and links one in a single step. A
linked agent authenticates with fleet-issued tokens and is minted no token of its own — one less
secret to store.

**Its capabilities are still kaambaan's.** They are chosen here and never carried in a
cross-plane token, because the same word means different things in the two systems.
