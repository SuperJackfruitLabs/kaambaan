---
title: Cards and their states
description: The unit of work, what can happen to it, and what each state means.
---

A card is the durable unit of work. It has a title, an optional brief, a priority, an optional due
date, labels, and an accountable human owner — always a person, even when an agent is doing the
work. It may belong to a project and one of that project's milestones, and it may be linked to
other cards. See [Planning work](/use/planning/).

## The eight states

| state | meaning | terminal |
|---|---|---|
| `submitted` | waiting to be claimed | |
| `working` | an agent holds it and is working | |
| `input-required` | an agent asked a question and is waiting for an answer | |
| `auth-required` | an agent needs a credential it does not have | |
| `completed` | finished | ✓ |
| `rejected` | declined by a human at a gate | ✓ |
| `failed` | an agent could not finish it | ✓ |
| `canceled` | withdrawn | ✓ |

These mirror the A2A task states, including the single-l spelling of `canceled`.

### A parked card says why

`input-required` is the one state a card can reach for five different reasons, so a card in it also
records which:

| reason | what happened |
|---|---|
| `question` | an agent asked something and is waiting for an answer |
| `review` | it is at an approval gate |
| `blocked` | a run blocked on a dependency, or a completion did not satisfy the stage |
| `repeated-failure` | two consecutive attempts failed and the breaker tripped |
| `not-authorised` | nobody with permission to dispatch this agent asked for this card to run |

The reason carries the detail with it — the run's own words for why it failed, the question's id,
the number of failed attempts. A card that stops without a reason is one somebody has to reverse
engineer from the activity log.

## Moving a card

Drag it, or use `Alt` and an arrow key — card movement is not mouse-only, and the board announces
the move for a screen reader.

A move into a stage at its **WIP limit** is refused, and the refusal names the limit. That is the
constraint doing its job: the point of a WIP limit is to be hit.

Three other moves are refused: into a stage while an **unresolved blocker** holds the card, out of
a card with **open sub-tasks**, and a move you might not expect to be a dispatch — moving a card
into an agent-claimable stage *is* dispatching it, so an agent doing the moving passes the same
checks a card creation does.

**Moving a card to a last stage nobody can act on finishes it** — which is what you mean when you
drag a card to `done`.

## Attempts

Each time an agent claims a card, that is a **run**. A card may accumulate several — a second
agent picking up after a failure starts a new one — and previous runs stay readable, so "what did
the last attempt do differently" is answerable.

After **two** consecutive failed or reclaimed runs the card stops being offered and waits for a
person. A card that cycles forever is worse than one that stops.

**Each run keeps its own record**, so the card can be read stage by stage: what that run handed on,
why it died if it did, and which references it attached. Before this, a run ended and took its
output with it — the card's handoff was a single field each stage overwrote, and the one party who
most needed to know why the last attempt failed, the agent about to try again, was the only one not
told. A retry is now handed the previous attempt's reason on its claim.

## Cost

Agents report token usage as they work, and superpipeline totals it per card and per board. You can set
a **USD cap** on either. A card over its cap is surfaced in Operate → Needs you rather than
silently continuing.

Where there is no cap, the card shows what it has spent and nothing is drawn as a proportion of a
number you never set.

## The spec

A card's brief is its **spec**: a JSON object of whatever fields its author wants. Three of them
have a meaning the card drawer knows, and are shown in their own sections:

| field | shape | shown as |
|---|---|---|
| `description` | string | the card's description, at the top of the drawer |
| `plan` | `[{ "t": "step", "done": false }]` | the agent's plan, as a checklist with a progress bar |
| `acceptanceCriteria` | string array | a bulleted list |

**`plan` accepts more than one shape.** Write `[{ "t": "step", "done": false }]`, or a plain
string array (`["Draft", "Review"]`, every step not done). Step objects may also name their text
`text`, `step`, `title`, `label`, `name` or `description`, and mark a step finished with
`done`, `completed` or `checked` set to `true`, or `status` set to `"done"`, `"complete"` or
`"completed"`. A step with no text is skipped rather than drawn as an empty box. If the checklist
cannot draw every step of a plan, the plan is also shown as written under Details.

**Every other field is shown under Details**, below them. Keys are spelled out as words
(`portraitDecision` reads "Portrait decision"), lists become bullets, nested objects become
labelled groups, and `http`/`https` URLs become links. Details starts open when the card has no
description, and collapsed when it is long and a description is already above it.

**The agent working the card receives the whole spec**, not only the fields the drawer has a
section for — so what Details shows is what the agent was told. Start every spec with a
plain-language `description`: it is the first thing a person reading the card sees, and the one
sentence an agent can act on before it has parsed the rest.

```json
{
  "description": "Write the release notes for 2.4 and link them from the changelog.",
  "acceptanceCriteria": ["Notes cover every merged PR", "Changelog links the notes"],
  "audience": "people upgrading from 2.3",
  "sources": ["https://example.com/milestone/2.4"]
}
```

## References

A card can carry links — a GitHub issue, a pull request, a document, any URL. Agents attach them
as they work, and a reference is upserted on its URL, so re-attaching the same link does not
duplicate it. Each reference records **which run attached it**, so "what did the audit stage
produce" is answerable.

GitHub and forge events can write onto a reference as they happen, so a pull request on a card
shows its current state rather than the state it was in when somebody pasted the link.

**There is no URL for a local file.** superpipeline stores no content, so a reference points at
something already published. A commit sitting unpushed on a machine is not evidence, which is what
[completion requirements](/use/runbooks/) exist to enforce.

## History

Every meaningful change is an event: created, moved, claimed, activity posted, gate resolved,
reference added. The card drawer shows its own; **Operate → Activity** shows the board's.
