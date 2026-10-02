# A card remembers what happened at each stage

**Status:** accepted 2026-10-02
**Follows:** `2026-10-02-a-coordinator-plans-the-work-design.md`

## Four questions, one missing fact

Asked of a live card mid-retry — "does the second attempt know why the first failed?" — the answer is
no. Pulling that thread found three more absences with the same shape: the board records enough to
*act* and not enough to *account*.

| asked | today |
|---|---|
| does a retry learn why the last attempt failed? | **no.** `claim()` hands back the card, the stage, and the previous STAGE's handoff. Nothing about the dead attempt. |
| can the UI show, stage by stage, what each agent did? | partly. Activities group by run already; the handoff, the references and the failure do not. |
| can a reference be a markdown file? | **no.** `addReference` refuses any scheme but `http`/`https`. References are pointers; superpipeline stores no content. |
| is each stage's handoff kept and shown? | **no.** `cards.handoff_json` is ONE column, overwritten at every `complete()`. Each stage destroys the last stage's handoff. |

Three of the four are the same defect: **a run ends and takes its output with it.**

- `fail()` sets `runs.outcome = 'crashed'` — a label, not a reason. The reason text goes to the
  `events` table and to a human's notification, and the agent about to repeat the work gets neither.
- `complete()` writes the handoff onto the CARD, so stage N+1's handoff overwrites stage N's. The
  history is gone the moment the card advances.
- `card_references` has no run or stage column, so "what did the audit stage attach" is unanswerable
  even though every reference it attached is still there.

The one party who most needs to know why the last attempt failed is the only one not told. The human
gets a notification, the event stream gets an event, the dead run keeps a label — and the agent about
to try again gets silence.

## The change: a run keeps its own output

Three additive columns, all guarded ALTERs, all NULL on existing rows:

```
runs.handoff_json      what this run handed on          (written by complete)
runs.failure_reason    why this run died                (written by fail/reclaim)
card_references.run_id which run attached this reference (NULL = attached before this existed)
```

Nothing is moved. `cards.handoff_json` stays exactly as it is — it is what the NEXT claim reads, and
changing that would be a behaviour change dressed as a schema one. The run's copy is the record; the
card's is the live input.

### 1. A retry is told why the last one failed

`ClaimResult` gains `lastFailure`:

```ts
lastFailure: { reason: string; agentId: string; stageKey: string; endedAt: string } | null
```

Read from the most recent ended run for THIS card and THIS stage. Null when the card has never failed
here, which is the common case and must stay cheap.

Scoped to the stage on purpose. A failure at `audit` tells an agent claiming `audit` something; it
tells an agent claiming `measure` almost nothing, and handing it over would read as "your work has
already failed once" about work that has not started.

Delivered, not discoverable. An agent *can* reach the history today (`get_card`, the attempts route —
and the one in the live incident did exactly that, calling `superpipeline_get_run` right after
re-claiming). But a fact that requires the agent to think of asking is a fact most agents will not
have, and the failure mode is an agent walking into the same wall until `CIRCUIT_BREAKER_LIMIT`
parks the card.

### 2. Each stage's handoff is kept

`complete()` writes the handoff to `runs.handoff_json` as well as to the card. `getAttempts` returns
it. The UI then has, per stage, the thing the agent actually said when it finished — in order, for
the life of the card.

### 3. A reference knows which run attached it

`addReference` takes an optional `runId` and records it. The MCP tool passes the caller's run, so an
agent attaching evidence mid-run needs no new argument. A human-added reference has no run, and NULL
is the honest value — not a fabricated one.

### 4. The UI: a stage-by-stage account

`CardDrawer` already groups activities by run (`groupActivities`), with narrative filtering because
"showing everything by default buries the 1.4% that tells the story". Each group gains a head and a
foot:

- **head** — the stage, the agent by name, when it started, which model, what it cost
- **foot** — how it ended: the handoff, formatted; or the failure reason, marked as a failure
- **between** — the references THIS run attached, as the chips the board already renders

Acceptance criteria, each checkable on a real card:

- **S1** a card worked at three stages shows three groups, oldest first, each naming its stage and agent
- **S2** a group whose run completed shows its handoff; a group whose run failed shows the reason, visibly distinct
- **S3** a reference attached during a run appears under that run, and a human-added one appears in the card's own list rather than under a run it did not come from
- **S4** a retry at the same stage is its own group — two attempts at `audit` are two entries, not one merged one
- **S5** a card from before this change renders without gaps: every new field is NULL and the UI says nothing rather than something false
- **S6** the handoff is formatted, not dumped. It is `JsonValue`, and in practice an object with a summary and next steps; a reader gets prose, not a JSON blob

### 5. Markdown references: answered, not built

A reference is a URL (`http`/`https` only — `addReference` refuses the rest). superpipeline stores no
content, so there is nothing to attach a file *to*. A markdown document is referenceable when it is
already published — a forge blob, a docs page — and that works today.

Storing content would be a different product: uploads, size limits, retention, a CDN, and a new
answer to "who may read this". Out of scope, and recorded here so the question is not re-asked as if
it were an oversight. The near-term alternative, if an agent needs to hand over prose longer than a
handoff: write it where it belongs (a forge commit, a docs page) and reference it. That is also the
only version a human can read without the board.

## Testing

- a retry at the same stage receives `lastFailure`; a first claim receives null
- `lastFailure` does NOT leak across stages, and does not resurrect after a successful run
- each stage's handoff survives the next stage completing — the regression the single column caused
- a reference attached in a run reports that run; one added by a human reports null
- a pre-change card claims, renders and completes with every new column NULL

## What this does not do

- No change to what `claim()` reads as its INPUT handoff: still the card's, still the previous stage's.
- No content storage, no uploads, no `file://` references.
- No change to `CIRCUIT_BREAKER_LIMIT`. Telling an agent why it failed should reduce repeats; if it
  does not, the limit is still what stops the loop.
