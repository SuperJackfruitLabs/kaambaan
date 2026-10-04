---
title: Recurring cards
description: Work that comes back on a cadence — the rule grammar, the timezone, and what happens when the last one is not finished.
---

A schedule puts a card on a board on a cadence. Maintenance, a weekly review, a monthly report —
anything you would otherwise remember to create.

```sh
supi schedule list <boardId>
supi schedule add <boardId> --title "Rotate credentials" --rule "monthly on 1 at 09:00" --tz Europe/London
supi schedule pause <boardId> <scheduleId>
supi schedule resume <boardId> <scheduleId>
supi schedule rm <boardId> <scheduleId>
```

Schedules are also editable from board settings.

## The rule grammar

Four forms, and deliberately not cron:

| form | example |
|---|---|
| `every <n> minutes\|hours\|days` | `every 30 minutes` |
| `daily at HH:MM` | `daily at 09:00` |
| `weekly on <mon-sun> at HH:MM` | `weekly on mon at 09:30` |
| `monthly on <1-28> at HH:MM` | `monthly on 1 at 09:00` |

Cron is a dependency, a parsing surface and a support burden, and these four are the whole of what
a maintenance cadence needs. The rule is stored as free text, so a cron expression could be
accepted later without a migration.

**Monthly stops at 28.** There is no 30th of February, and a rule that silently means "the last
day" in some months and a real date in others is a rule nobody can read.

**The shortest interval is five minutes**, and asking for less is refused rather than accepted and
quietly rounded. The sweep runs every five minutes, so anything shorter is a promise the board
cannot keep.

## Timing

A schedule carries a **timezone**, by IANA name — `Europe/London`, not an offset. `daily at 09:00`
in a zone that observes daylight saving means nine in the morning on both sides of the change,
which an offset cannot express.

The sweep runs every five minutes, so **a card may appear up to five minutes after its stated
time**. It will not appear early.

## When the last one is not finished

Each schedule says what to do if its previous card is still open:

| `overlap` | behaviour |
|---|---|
| `skip` (default) | do not fire; count the skip |
| `allow` | fire anyway |

`skip` is the default because a nightly job that takes two days produces a growing pile of
identical cards under `allow`, and the pile is not more informative than the first one. The skips
are counted and shown, so a schedule that never fires is visible as a schedule that keeps skipping
rather than as silence.

## A schedule carries its own authority

A card has to have a human owner, and a schedule fires long after whoever created it has gone
home. So the schedule records **who created it and what they were permitted to dispatch** at the
time, and the cards it creates carry that.

Two consequences worth knowing:

- A schedule that records no creator is **disabled** rather than allowed to mint ownerless cards.
- A rule that no longer parses is **disabled and said so loudly** on the event log, rather than
  retried every five minutes forever.

## Next

- [Planning work](/use/planning/) — labels, due dates, projects and blockers
- [Boards and pipelines](/use/boards/) — where schedules are configured
