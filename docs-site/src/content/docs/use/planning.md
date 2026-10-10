---
title: Planning work
description: Labels, due dates, projects, milestones, blockers and sub-tasks — the constructs for saying what matters, when, and in what order.
---

A board says what happens to a card. These say which cards matter, when they are wanted, and what
has to happen first.

## Labels

A label is a workspace-wide record — a name and a colour — and cards carry label **ids**, not
names, so renaming a label does not orphan every card holding it.

```sh
supi label list
supi label add urgent "#d6453d"
supi label rm lbl_…
```

Names are unique case-insensitively: `Urgent` and `urgent` are the same label.

Each label records **how it came to exist**. A label you declare is `declared`; one typed straight
into a card's Labels field is registered on the spot as `inferred`. The distinction exists so you
can answer "which of these did nobody ever mean to create?" and find a typo after the fact.

Removing a label leaves the id on the cards that carried it. They show nothing rather than showing
a dangling name.

## Due dates

A due date is a date, not a timestamp — `2026-10-09`, no time, no zone.

It is load-bearing in two places:

- **Claim order.** Cards are handed to agents by priority first, then by due date — soonest first,
  undated last — then by age. A due date is how you tell the board what to do next, not a
  decoration.
- **An overdue card tells its owner.** A per-board sweep notifies the card's owner once when it
  goes past due. Once, not every pass: the nag re-arms only when the date itself changes, so
  editing a card's title does not start it again.

## Projects and milestones

A project groups cards **across boards**. That is the whole reason it exists: a board is the unit
of isolation and cards never cross one, so anything that spans boards cannot live inside a board.

```sh
supi project add "Autumn release" --target 2026-11-30 --lead usr_…
supi milestone add prj_… "Beta" --target 2026-10-31
supi project show prj_…
```

A card may belong to one project and one of that project's milestones. A milestone belongs to
exactly one project — setting a milestone from a different project is refused.

### The rollup admits what it could not read

A project's progress — cards total, done, overdue, and cost — is computed by reading every board
the project touches, and the result is **cached**. It is informational, not enforcement: nothing
refuses a claim because a project is behind.

If a board does not answer, the rollup is returned anyway, marked `partial` and carrying how many
boards were missed. A total that silently omits a board is worse than one that says it is
incomplete.

## Blockers and sub-tasks

An edge between two cards. Three kinds:

| kind | meaning | enforced |
|---|---|---|
| `blocks` | this card cannot be worked until that one is resolved | ✓ |
| `parent` | that card is a sub-task of this one; the parent does not advance while a child is open | ✓ |
| `relates` | these are connected. Decoration. | — |

```sh
supi link add <boardId> <fromCardId> <toCardId> --kind blocks
supi link list <boardId> <cardId>
supi link rm <boardId> <fromCardId> <toCardId> --kind blocks
```

A blocked card **drops out of claim and out of work discovery** — an agent is never offered it —
and a move into a stage is refused while a blocker is unresolved.

**"Resolved" means `completed` or `canceled`, and deliberately not `failed`.** A blocker that
failed is exactly the case where the dependent card must stay blocked; otherwise the edge does
nothing in the only situation anybody added it for.

A cycle among the ordering kinds is refused when you try to create it, rather than discovered when
two cards wait on each other forever.

### Sub-tasks

An agent working a card can split it into sub-cards — at most twenty in one call — when the work
has independent parts different capabilities should pick up. You can do the same from the card.

The parent **waits**: a completion that arrives while children are open is deferred rather than
refused. The card parks in its current stage, its owner is told which sub-tasks it is waiting on by
name, and the advance resumes by itself when the last child resolves. Refusing the completion
instead would throw away work the agent had already done; leaving the run open would let the lease
time out and the card be reclaimed, which is the retry loop this avoids.

## Cross-board edges are advisory, and say so

A `blocks` or `relates` edge may point at a card on **another** board, and it is **advisory** —
shown, never enforced. The two ends live in two different boards, and any enforcement would rest on
a cross-board read that is stale the moment it returns. The interface says so before you create
one.

`parent` cannot cross a board at all. A parent edge carries a rule — a parent does not advance
while a child is open — and an advisory containment relationship is one that fails to contain. Use
a project to group cards across boards.

## Archiving

```sh
supi archive <boardId> <cardId>
```

An archived card leaves the board's lanes and the claim queue without being deleted, and the "show
archived" filter brings it back into view.

Archiving cancels anything the card was waiting on a person for: its pending approval gates and
questions are closed, so they no longer appear in Needs you or `supi gates`. Restoring the card does
not bring them back. A card that was waiting comes back parked as blocked, with the reason on it;
resume it to an earlier stage or move it to start it again.

## Next

- [Recurring cards](/use/recurring/) — work that comes back on a cadence
- [Cards and their states](/use/cards/) — what a card is, and what can happen to it
