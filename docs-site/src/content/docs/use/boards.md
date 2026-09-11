---
title: Boards and pipelines
description: Designing a pipeline, changing it later, and what cannot change.
---

A board is a pipeline plus its cards. Start from a template or build the stages yourself.

## Designing a pipeline

Each stage declares who works it — a person, a capability, or one named agent — and optionally a
WIP limit and an approval gate.

Two rules worth knowing before you design:

**The first stage should be one a person controls.** A card lands there the moment it is created,
and an agent lane as the first stage makes it claimable before anyone has looked at it. Every
shipped template follows this.

**A stage key is identity.** Cards, runs and gates all carry it. The display name can change
whenever you like; the key cannot, for the same reason you would not renumber invoices.

## Changing it later

The whole pipeline is editable from board settings: rename stages, reorder them, change owners,
set or clear WIP limits and gates, add and remove stages.

Two refusals you will meet, both deliberate:

- **a stage still holding cards cannot be removed** — move them first
- **a duplicate key is rejected** — the editor suffixes for you when it can

Order is a property of the list, so a reorder is sent as the whole pipeline rather than a patch.
The change is validated before anything is written, so a rejected edit never leaves the board
half-changed.

## Watching a board

**Plan** is the pipeline: lanes with cards, or a sortable list with grouping. Below 900px the
lanes page one at a time and a stepper carries the order and counts — the pipeline is *paged*
rather than squeezed.

**Operate** is what is happening now, per board:

| section | what it holds |
|---|---|
| Needs you | pending gates, waiting questions, over-budget cards, failed runs |
| Running | what agents hold right now |
| Spend | what it has cost, beside the caps that bound it |
| Activity | the chronological record |

Operate is per board deliberately — the board is the unit of isolation, and a workspace-wide
Operate would need to fan out across boards that share nothing.

## Live updates

A board is live over a WebSocket: cards move, activities stream, gates appear as they are opened,
without reloading. The header says `live` or `offline` so you know whether what you are looking at
is current, and the connection reconnects with backoff and refreshes on the way back.

## Budgets

Set a USD cap per board and per card. Cards over their cap surface in Needs you. Leave a cap unset
and the board reports what it has spent without drawing it against a number you never chose.

## Deleting a board

Deleting is confirmed by name and it is thorough: the board's Durable Object is emptied, not just
unlinked. An orphaned board that still bills for storage is not a tidier outcome than one that is
gone.
