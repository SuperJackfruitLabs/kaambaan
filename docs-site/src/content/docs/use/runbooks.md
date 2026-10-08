---
title: Stage runbooks and completion
description: Telling a stage's workers what to do, and declaring what the board must see before it believes them.
---

A stage can carry two standing rules: **what to do here**, and **what counts as having done it**.
They are a pair. The first is advice, the second is enforcement, and the reason to set both is that
advice alone loses.

## Instructions: the stage's standing rule

A stage's `instructions` are prose handed to whoever claims a card there — every card that reaches
the stage, every agent that can claim it. It is a stage's rule, never a card's.

```sh
supi set-stage <boardId> <stageKey> --instructions runbook.md
```

Write it as the runbook you would hand a new colleague: what the stage is for, what to produce,
where to put it, and what to do when the work does not fit. It arrives in the agent's prompt.

**Instructions are advisory.** An agent can ignore them, and an agent that ignores them still
reports success. That is what the second rule is for.

## Completion: what the board must see

Before this existed, `complete()` was unconditional — an agent calling it was the sole author of
the claim that its stage was done. A board reported `published` over a commit sitting unpushed on
a machine, and `completed` for a run that had explicitly refused to publish. Both had already been
"fixed" with instructions telling the agent what to do.

A completion requirement makes finishing **earnable**:

```sh
supi set-stage <boardId> verify --completion completion.json
```

```json
{
  "handoff": ["summary", "commit"],
  "reference": { "provider": "github", "sourceType": "pull_request" }
}
```

| arm | demands |
|---|---|
| `handoff` | the run's handoff is an **object** carrying each named key, present and non-blank. A bare string is a summary, not a report, and is refused as one. |
| `reference` | a reference of that shape is already attached to the card — matched on `provider`, `sourceType`, or both |
| `live` | reserved. A stage may declare it and it is recorded as *not checked* rather than passed; live verification is not built yet. |

Leave `completion` unset and the stage behaves as every stage did before this existed: anything the
agent says is accepted.

## What a failed check does

**It blocks; it does not fail.** The run's outcome is recorded `blocked`, and an `error` activity
naming every missing piece is written onto the card.

**The first refusal is reworked once, automatically.** The card goes back to `submitted` on the same
stage with feedback naming exactly what was missing — `handoff.feedback`, plus the refused handoff as
`handoff.refusedHandoff` — which the next agent to claim it reads. **A second refusal on the same
visit to the stage parks the card on a person**, as `blocked`, with both refusals in its reason.

Blocking rather than failing is deliberate. A failure re-queues the card over and over until the
breaker trips, and a retry loop would spend budget re-asserting the same untrue claim. One rework is
enough to catch an agent that forgot a field; after that, someone has to look. The rework counts as
an attempt, so the [circuit breaker](/use/stuck-cards/#what-heals-itself) still bounds it.

Every failing arm is named at once, so a person fixes both rather than discovering the second on
the next attempt.

## A card may override its stage

A card can carry its own `completion`, and it **replaces** the stage's rather than merging with it —
so a card saying `{}` means "this stage's rule does not apply to this card". A merge would make
that impossible to say.

The override is recorded on the run. Routing around a check is a legitimate act; a silent one is
not.

## Human stages carry the other half

A human stage takes no completion requirement — there is no run to check. It still needs
`instructions`, and this is the gap most boards have: the agent stages are instructed and the
stages where work reaches the world are silent.

`accepted`, `signed-off`, `published`, `released` — these are where somebody merges, publishes or
signs. If nothing at that stage says whose act it is and what it consists of, the card arrives and
waits, and a pipeline that looks automated stops at the step nobody was told to do.

Write the delivery act down, naming who does it:

> **The merge happens here.** Open the pull request named in the handoff, check CI is green, and
> merge it. If there is no pull request reference on this card, the previous stage did not finish —
> move it back rather than merging by hand.

## Setting one stage without touching the others

`set-stage` patches **one** stage. `set-stages` replaces the whole pipeline, which has destroyed
stage instructions once — a whole-pipeline write discards whatever it was not told about, including
a concurrent edit to a stage nobody meant to touch.

Prefer `set-stage`. An agent holding `compose` may set `instructions` and nothing else: the owner,
order, gate and WIP limit are routing, and wrong routing strands every card in the lane silently.

## Next

- [Writing an agent](/build/agent-contract/#earning-a-completion) — the same rules, from the agent's side
- [Boards and pipelines](/use/boards/) — where stages are designed
