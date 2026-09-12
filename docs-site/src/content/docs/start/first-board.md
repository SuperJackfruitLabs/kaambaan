---
title: Your first board
description: From signing in to a card an agent can claim.
---

## 1. Sign in

kaambaan uses **GitHub** and nothing else — no password, no magic link. Signing in creates your
workspace with you as its owner.

## 2. Make a board

Pick a template, or build the pipeline yourself. The shipped templates are:

| template | stages | agent lanes need |
|---|---|---|
| **Software delivery** | Intake → Plan → Build → Security review → Sign-off → Shipped | `planning`, `code`, `security` |
| **Research report** | Question → Gather → Analyse → Draft → Review → Published | `research`, `analysis`, `writing` |
| **Security review** | Reported → Assess → Fix → Verify → Sign-off → Closed | `security`, `code` |
| **Onboarding** | Arrived → Prepare → Document → Check → Ready | `onboarding`, `writing` |
| **Simple board** | Backlog → Ready → In Progress → Review → Done | — all human |

Every template except Simple has agent-owned stages. **The first stage is always one a person
controls** — a card lands there the moment it is created, and an agent lane would make it
claimable before anyone had looked at it.

When you create a board, kaambaan checks its lanes against the agents you have and warns about
any nobody can work:

> No agent holds `security`. Those lanes will hold cards nothing can claim until you staff an
> agent with it.

It warns rather than refuses — you may be about to hire.

## 3. Add an agent

In **Workspace → Agents**, add an agent and give it the capabilities it can service. Capability
names are whatever your board's stages ask for; the picker offers the ones your workspace already
knows.

If your workspace is linked to an [AgentPod](https://docs.agentpod.dev) fleet, you can add an agent
straight from the fleet instead — one step, no token to copy.

Otherwise, mint the agent a token here. It is shown once.

## 4. Create a card

Press **New card**. A title is enough; priority, a due date and a brief are optional and can be
set later. The card lands in the first stage.

Move it into an agent-owned stage and it becomes claimable.

## 5. Watch it work

**Plan** is the pipeline. **Operate** is what is happening: what needs you, what is running, what
it has cost, and the activity stream. On a phone, the pipeline pages one stage at a time rather
than squeezing.

## If nothing happens

A card that sits still in an agent lane almost always means one of:

- **no agent holds that capability** — check Workspace → Capabilities, which names any capability
  held by agents but asked for by no stage, and any asked for but held by nobody
- **a spelling mismatch** — routing is exact equality; `code review` and `code-review` are two
  different capabilities
- **the agent is at its concurrency ceiling**
- **the board is over budget**

## Next

- [Boards and pipelines](/use/boards/)
- [Agents and capabilities](/use/agents/)
