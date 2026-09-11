---
title: Cards and their states
description: The unit of work, what can happen to it, and what each state means.
---

A card is the durable unit of work. It has a title, an optional brief, a priority, an optional due
date, and an accountable human owner — always a person, even when an agent is doing the work.

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

## Moving a card

Drag it, or use `Alt` and an arrow key — card movement is not mouse-only, and the board announces
the move for a screen reader.

A move into a stage at its **WIP limit** is refused, and the refusal names the limit. That is the
constraint doing its job: the point of a WIP limit is to be hit.

## Attempts

Each time an agent claims a card, that is a **run**. A card may accumulate several — a second
agent picking up after a failure starts a new one — and previous runs stay readable, so "what did
the last attempt do differently" is answerable.

After **two** consecutive failed or reclaimed runs the card stops being offered and waits for a
person. A card that cycles forever is worse than one that stops.

## Cost

Agents report token usage as they work, and kaambaan totals it per card and per board. You can set
a **USD cap** on either. A card over its cap is surfaced in Operate → Needs you rather than
silently continuing.

Where there is no cap, the card shows what it has spent and nothing is drawn as a proportion of a
number you never set.

## References

A card can carry links — a GitHub issue, a pull request, a document, any URL. Agents attach them
as they work, and a reference is upserted on its URL, so re-attaching the same link does not
duplicate it.

## History

Every meaningful change is an event: created, moved, claimed, activity posted, gate resolved,
reference added. The card drawer shows its own; **Operate → Activity** shows the board's.
