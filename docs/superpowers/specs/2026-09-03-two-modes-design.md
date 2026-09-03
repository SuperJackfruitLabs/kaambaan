# Two modes, both real on a phone

**Status:** proposed, 2026-09-03
**Repo:** `kaambaan` (`apps/web` only — no API change)
**Supersedes in part:** `docs/superpowers/specs/2026-06-22-kaambaan-flight-deck-wireframe-design.md`
**Evidence:** the UI/UX audit of 2026-09-03, measured in a browser at 1440×900 and 390×844
**Parity:** every one of 75 shipped surfaces is mapped in the parity matrix; three are removed
deliberately and are named in §8.

---

## 1. The problem, measured

The audit found three classes of failure. Only the first is severe, and it is severe.

**Unreachable.** The topbar is one `flex` row with `flex-wrap: nowrap` and no horizontal scroll.
At a 390px viewport the row is **813px** wide, so seven controls sit past the right edge and are
clipped by the page — not scrolled to, absent. Among them is **Agents**, which is the only door to
the capability registry, members, tokens and the fleet link. Every management surface built in the
last week does not exist on a phone.

Alongside it: computed `outline-style` is `none` on buttons **and card tiles**, so there is no
visible keyboard focus anywhere — which makes the `Alt`+arrow card movement shipped on 2026-09-02
unusable by the people it was built for. And eight interactive targets are below the 24×24 CSS
pixel floor, including the `⇄` move control at **15×11** and the compose expander at **15×16**.

**Untrue.** The same `var(--live)` green means "socket connected" in the topbar, "an agent is
working" on a card, and — in the rail — "this agent has at least one capability". In a list of
workers a green dot reads as *online*, which kaambaan cannot know: `agents.status` was dropped in
migration 0005 precisely because nothing ever wrote it. Also `SPEND $0.00` on a board with no
budget, and a `0` notification badge.

**Unreadable.** Lanes are a fixed 288px with ~50px arrows, so four of six stages fit at 1440px and
the fourth is cut through its title; five empty lanes each render a full-width `AWAITING WORK`
box. `UNASSIGNED` is the most repeated word on the board, beside a second avatar that is almost
always `U`. The agents modal is six unrelated sections in one scrolling column.

**The pattern worth naming:** three of these defects are in features added in the two days before
the audit, and two undermine the goal that motivated them. Surface is arriving faster than the
conventions that would make it usable.

## 2. What is not changing

The identity is not the problem and is kept exactly: **marigold as the only accent**, **mono for
machine-issued values**, the **flow arrows and waypoint language**, the wordmark, and both themes
with their existing token names (`--ink`, `--surface`, `--inset`, `--line`, `--text`, `--muted`,
`--marigold`, `--live`, `--coral`, `--accent-bg`).

No API, Durable Object or database change. Every screen below is built from endpoints that already
exist.

## 3. The structure

Three destinations replace three nav items plus two topbar widgets plus one modal.

| destination | what it answers | absorbs |
|---|---|---|
| **Plan** | what is the shape of the work | Board, List |
| **Operate** | what needs me, what is running, what it cost | Triage, Telemetry, the notification bell, the spend pill |
| **Workspace** | who and what may act here | the agents modal, all six of its sections |

**Operate absorbing four surfaces is the move that fixes the topbar.** The row is not rearranged;
it is given fewer reasons to exist. What remains is four items that cannot overflow: board
switcher, connection indicator, search, primary action.

**Operate is scoped to one board** (decided 2026-09-03). The Durable Object is per board, so a
cross-board deck would need a fan-out read across every board's DO, and the board switcher would
have to move out of the shell into Plan. Recorded as a limit: work needing attention on another
board is discovered when you switch to it.

## 4. Routes

Today the app is three routes plus a screen enum in the store, with settings and agents as modals.
That is why the address bar cannot describe where you are. Each destination becomes a route.

```
/                                    → redirect to the remembered board
/b/:boardId                          → Plan
/b/:boardId/c/:cardId                → Plan, card open
/b/:boardId/operate                  → Operate
/b/:boardId/operate/telemetry        → Telemetry detail
/b/:boardId/settings                 → board settings (pipeline, GitHub, agent profiles)
/workspace/agents                    → Workspace, and the default tab
/workspace/capabilities
/workspace/people
/workspace/connections
```

`app.setScreen()` and the `Screen` union are deleted. The card drawer stays a route because a card
link must survive being pasted to someone.

## 5. The shell

One breakpoint, **900px**, expressed mobile-first as `min-[900px]:`. Never paired with
`max-[900px]:` — Tailwind's `max-` is exclusive, and pairing them leaves exactly 900px matching
both, which is how the console redesign shipped a layout that was two layouts at once.

**Below 900px** — header, canvas, bottom navigation of three destinations. Each bottom-nav target
is at least 50px tall. The primary action is a floating button in the canvas, above the nav.

**At 900px and up** — an 84px rail on the left carrying the wordmark, the three destinations, and
a footer with theme and the account row. Header and canvas to the right.

**The header is the same in every mode** and holds exactly four things, in this order: the board
switcher, the connection indicator, search, the primary action. Nothing may be added to it without
removing something; it is the surface that failed, and the fix is a budget.

**The primary action opens the compose sheet** — title, priority, due date and description as
first-class fields, not a title box with a 15×16px expander beside it. It is the same sheet on
both layouts: a dialog at 900px and up, a full-screen sheet below.

The board switcher opens a **searchable** menu, most-recent first, with the search field appearing
past eight boards. The rail's flat board list is gone — it had no behaviour that changed between
three boards and three hundred.

## 6. Plan

**Header row:** a view toggle (`board` · `list`), a filter control, and the active filters
rendered beside it as removable chips. A filtered board must never silently misrepresent what it
is showing.

**At 900px and up:** lanes of **264px** separated by a thin chevron, so five to six stages are
visible at 1440px rather than four with one cut. An empty lane is a single dashed strip about 34px
tall, not a full-height box.

**Below 900px:** the pipeline survives rather than collapsing. A horizontally scrollable **stage
stepper** carries the stage order and each stage's count; below it, one lane fills the viewport
width with `scroll-snap-type: x mandatory`. Left-to-right remains the model, because that is the
identity that was deliberately kept. The list view is one tap away for when reading beats scanning.

### The card tile

Rendered in this order, and a field that has no value is not rendered at all:

| element | rule |
|---|---|
| priority | a 3px left edge stripe — coral at P1, marigold at P2, absent otherwise |
| title | always |
| labels | when present |
| reference chip | when present; one line, truncated, sub-state kept |
| working agent | avatar plus handle, **only when an agent holds the card** |
| due date | when set; coral with a warning glyph when overdue and the card is not complete |
| cost | when the board has a card cap, as a figure and a bar against that cap |
| gate / question actions | when the card has a pending gate or elicitation |
| move control | a 24px minimum button, revealed on hover **and on focus** |

`UNASSIGNED` is removed. The owner avatar is removed from the tile and lives in the drawer. The
board's default state is that nobody has picked a card up; that should be the quietest thing on
the card, not the loudest.

### The card drawer

Unchanged in content — description, acceptance criteria, session activity, decisions, handoff,
cost, attempts, references, and the edit, assign, delete, answer and resolve actions all stay as
they are. Only its container changes: a side panel at 900px and up, and **full screen with a back
control** below it. Eight sections is more than a bottom sheet can carry.

## 7. Operate

Four sections, in this order. All four are reads of state that already exists.

**Needs you.** One row per thing waiting on a person, each carrying its state, what it is about,
and **its action on the row**. Six sources: a pending gate, an agent's question, a card refused at
claim under the control pair, a failed card, a dead-lettered push delivery, and a board over
budget. A row's primary action resolves it where it stands — approving from Operate and approving
from the card tile are both correct, and both are kept.

**Running.** Cards currently claimed: agent, card, stage, elapsed, cost.

**Spend.** The board total against its cap, and cost by agent. A **Detail** sub-view at
`/operate/telemetry` carries by-model, by-card, the 5h/7d window toggle, and the board event log.
The budget-cap controls live here, beside the figures they cap.

**Activity.** The notification feed, chronological, with read state and mark-as-read. Kept rather
than absorbed into Needs you: derived attention answers *what should I do*, a chronological record
answers *what happened*, and collapsing them would drop every non-actionable notification.

## 8. Workspace

A route with four tabs — tabs at 900px and up, a stacked accordion below it.

- **Agents** — the list, edit, delete, token issue and revoke, principal link. A token id is
  shown as a count ("1 token") with the ids behind the row menu; an id is machine data and was
  occupying the position a human's eye lands on first. The "not linked to a suite principal"
  explanation is stated **once above the list**, not repeated verbatim on every unlinked row.
- **Capabilities** — the registry, its agent and board counts, add, describe, delete, and the
  orphan warning.
- **People** — members, invite, role change, remove.
- **Connections** — the workspace fleet link, Connect to AgentPod, and the "add from AgentPod"
  picker.

### Removed deliberately

Three things, each because it asserted something untrue:

1. **The green dot beside each agent.** It meant "has a capability" and read as "online".
2. **The `0` notification badge.** A badge means "there is something".
3. **`UNASSIGNED` on the card tile**, and the second always-`U` owner avatar.

## 9. The system

Two tokens, and one rule each, which between them close three audit findings.

```css
--focus: 2px solid var(--marigold);
--focus-offset: 2px;
--tap: 24px;                       /* WCAG 2.2 target size minimum */
@media (pointer: coarse) { --tap: 44px; }
```

- **One `:focus-visible` rule, applied at the root of the app**, not per component. Every
  focusable element shows it, card tiles included.
- **Every interactive element is at least `--tap` in both dimensions.** Where a control must look
  small, the hit area is padded rather than the glyph enlarged.

### Acceptance criteria

Measurable, because the audit was measured. At 390×844 and 1440×900, on Plan, Operate, Workspace
and an open card:

1. No element's right edge exceeds the viewport width.
2. `document.documentElement.scrollWidth === window.innerWidth`.
3. Every element matching `button, a, input, select, [role="button"]` with a non-zero box is at
   least 24×24.
4. Every focusable element has a computed focus indicator under `:focus-visible`.
5. The board is fully operable by keyboard: reach a card, move it between stages, open it, resolve
   a gate, answer a question.
6. Both themes pass, and neither is defined only inside a media query.

## 10. Out of scope

- **Cross-board Operate.** Recorded in §3 as a limit, not an omission.
- **The Linear-parity programme** in `docs/13` — sub-issues, relations, saved views, search,
  comments. This spec changes where things live; it adds no card features.
- **The affordance capability registry** (`decisions/2026-09-02-capability-is-three-words.md`).
  A different artifact from the one kaambaan has.
- **Any API, DO or schema change.** If a screen here appears to need one, that is a finding about
  this spec and should be raised rather than absorbed.

## 11. Sequencing

Four slices, in this order, each shippable on its own. The order is by severity, not by size.

1. **The system and the shell.** Focus, tap targets, the 900px breakpoint, the rail, the bottom
   navigation, the four-item header, and the routes. This alone closes the entire *unreachable*
   class, which is the only severe one.
2. **Plan.** Lane density, the stage stepper, the redesigned tile, the compose sheet, filter chips.
3. **Operate.** Needs you, Running, Spend and Activity, plus the Telemetry detail sub-view.
4. **Workspace.** The four tabs, and the agents modal retired.

Slices 1 and 2 leave the old agents modal in place; it is reachable from the rail until slice 4
replaces it. No slice removes a surface before its replacement exists.

## 12. Risk

The largest is that this is a wholesale replacement of `apps/web`'s structure with a test suite
that is thin at the component level: 41 web tests, and no render harness. The mitigations are the
parity matrix — 75 rows, so a surface cannot be dropped by accident — and the measurable criteria
in §9, which are checkable in a browser rather than by reading. The e2e suite is the only existing
guard on navigation and must stay green throughout; where it asserts on a structure this spec
changes, the assertion is updated in the same commit as the change and never deleted.
