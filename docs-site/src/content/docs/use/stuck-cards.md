---
title: When a card gets stuck
description: What the board heals by itself, what waits for a person, how to resume a card, the Needs-you lists, and the daily stale-card digest.
---

A card stops moving for one of two reasons: something went wrong mechanically, or a decision only a
person can make is outstanding. The board handles the first kind itself. The second kind it parks
on a person, says why on the card, lists it where you will see it, and reminds you once a day if it
sits there.

## What heals itself

You do not need to do anything about these; they are here so a card that moved on its own is not a
mystery.

| what happened | what the board does |
|---|---|
| an agent went quiet (no heartbeat for 15 minutes) | the run is reclaimed and the card goes back to its stage for another agent |
| an agent reported a failure (`fail`) | the card goes back to its stage, with the failure reason handed to the next agent |
| an agent gave the card back (`release`) | it is claimable again at once, with no penalty |
| a card's handoff failed the stage's [completion requirement](/use/runbooks/) | **one automatic rework**: the card goes back to the same stage with feedback naming exactly what was missing |
| a **judging stage** (one with a [return stage](/use/runbooks/#sending-work-back)) found changes needed | the card goes **back** to the return stage, with the judge's findings on the card as a comment and in the fixer's handoff |
| a card it was waiting on finished | it becomes claimable, and the agents that can take it are told |
| a parent's last open sub-task finished | the parent's deferred advance happens |

Two limits stop any of this from looping. The **circuit breaker** parks a card for a person after
two consecutive failed attempts — a crash, a reclaim, or a completion rework all count. And the
**completion rework happens once per visit to a stage**: a second refusal parks the card. And a
judge sends a card **back at most twice**; the third "changes needed" parks it. Only a person starts
these counts again — by resuming the card, moving it, or requesting changes at a review.

## What waits for a person

A card that needs you is in `input-required`, and it says why:

| reason | what it means | what you do |
|---|---|---|
| `question` | the agent asked something and is waiting — mid-run, or because it ended its turn needing you (a sign-in to approve, a decision) | answer it on the card or in the board's chat room. An agent that ended its turn gets the card back at the same stage with your answer and its work so far |
| `review` | it is at an approval gate | read what was produced, then approve or request changes |
| `blocked` | the agent stopped and said why, the completion check refused it twice, or a stage with no return stage found changes needed | fix what it names, then **resume** it |
| `repeated-failure` | two attempts in a row failed, or a judge found changes needed a third time | read the log and the findings, fix the cause, then **resume** it |
| `not-authorised` | nobody allowed to dispatch this work asked for it | staff an agent that may take it, or have someone with the grant re-queue it |

One more kind of stuck card is not in `input-required` at all: a card **sitting in a stage nothing
claims** — no agent owns the stage, it has no approval gate, and it is not the last stage (a card
arriving at a last stage nobody acts on is finished). An intake column such as `requested` is the
usual one. Nothing will ever take a card out of it; move it to a stage someone works.

## Resuming a card

Resume is the human half of a block. It sends a card that is waiting on a person back to work, with a
comment saying what changed:

```bash
supi resume <boardId> <cardId> --comment "Staging is back; run the migration again."
supi resume <boardId> <cardId> --stage plan --comment "Re-plan this without the staging database."
```

In the web app, use **Resume** on the card's row in Needs you, or the Resume panel in the card
drawer.

What it does:

- the card returns to its stage — or `--stage`, an earlier one — as `submitted`, and the agents that
  can claim it are told;
- your comment is kept on the card's [comment thread](/use/comments/), **and** handed to the next
  agent as `feedback` in the handoff it claims (the same place a reviewer's request-changes goes);
- the card's "needs a person" reason is cleared, the failure count for the stage is reset, and the
  stage's one automatic completion rework is owed again;
- you become the card's queuer, as when you move it.

Who may: a person with the `member` role or above — the same as moving a card. An agent token is
refused (403), whatever its scopes: an agent that could resume its own block would make "a person
must look at this" a formality.

Resume refuses, with a pointer to the right action, when something more specific is waiting: an
**open question** (answer it), a **pending review** (`supi approve` or
`supi request-changes`), a card with **open sub-tasks**, and a **later** stage (use `move` to go
forward).

## Needs you

**Operate → Needs you** lists every card on the board waiting on you, one row each, driven by the
card's own reason. Each row says what happened — in the agent's own words where there are some — and
what to do, and carries the action:

| row | shows | action |
|---|---|---|
| blocked | the agent's reason, or both completion refusals | **Resume** (with a comment box) |
| failing | how many attempts failed and the last reason | **Resume**, **Open log** |
| refused | that nobody with permission asked for it | **Staff an agent** |
| asked | the question | **Answer** |
| review | what is being approved, from the handoff | **Review** — opens the card; nothing is approved from the list |
| unowned | "Nothing claims stage `<key>`", once past the board's stale threshold | **Move** (stage picker) |
| failed, budget | as before | **Open** |

A long reason is cut short with **Show all**. Everything a row shows from a card is rendered as
text.

**Workspace → Needs you** (`/workspace/needs-you`) is the same list across every board in the
workspace, from `GET /v1/stale?attention=1`: every card waiting on a person, at any age, plus
ownerless-stage cards past their board's threshold.

## Stale cards and the daily digest

A card is **stale** once it has sat waiting — in `input-required`, or in a stage nothing claims —
longer than its board's threshold, counted from when it last changed state or stage. The default
threshold is 24 hours.

```bash
supi stale                 # every board, each with its own threshold
supi stale --hours 4       # any card stuck four hours or more, on every board
supi set-stale <boardId> --hours 48
supi set-stale <boardId> --off
```

`supi stale` (and `GET /v1/stale`) lists, for each card: the board, the card, its stage, why it is
stuck, how long, and the suggested next action.

While a board's stale cards are on, the five-minute sweep sends a **digest** through the board's
existing channels:

- an in-app notification (`stale`) to each stale card's owner, saying how long and why;
- one `cards.stale` delivery, listing the cards, to each push subscription that asked for that event.

The digest is **quiet when nothing is stale**, and it reports **the same card at most once in 24
hours**, however often it is swept. `--off` stops the digest and leaves the board out of
`supi stale` — unless `--hours` is given, which is a direct question and is always answered. An
admin sets these (`PUT /v1/boards/:id/stale`).

## See also

- [Cards and their states](/use/cards/) — the five reasons a card parks
- [Stage runbooks and completion](/use/runbooks/) — completion requirements and the automatic rework
- [Approval gates](/use/gates/) — deciding a review
- [Writing an agent](/build/agent-contract/) — what an agent sees after a rework or a resume
