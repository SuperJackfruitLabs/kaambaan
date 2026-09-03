# Smarter routing, and a registry that says more than a name

**Date:** 2026-09-03
**Status:** approved, in build
**Prior art:** `kaambaan#56` (the registry), `kaambaan#57` (the templates),
`charter → decisions/2026-09-02-capability-is-three-words.md`

## The problem

Routing is `capabilities.includes(stage.owner)` — one string, exact equality, a
boolean. That gives a lane exactly one way to describe what it needs, gives the
registry no way to say two capabilities are related, and gives nothing outside
kaambaan any way to read the vocabulary at all.

This builds the five things that are buildable **without crossing the
Durable Object / catalog boundary**. Everything that needs run history —
fit scoring, a reservation window, `demonstrated` provenance, honest
cross-board concurrency — is deliberately out of scope, because the catalog
has no `runs` table and inventing one inside a routing change would be the
wrong place to decide it.

## S1 — A stage may require a set

A stage gains an optional sibling to `owner`:

```ts
requires?: { all?: string[]; any?: string[] }
```

`requires` wins when present; `owner` is unchanged and remains what the UI
writes for the single-capability case.

**Why a sibling field and not a union on `owner`.** This was decided by a
probe, not by taste. SQLite's `json_each` over a **missing** path returns zero
rows cleanly, but over a **scalar string** it raises `malformed JSON`. So
widening `owner` to `string | {all: […]}` would make `listCapabilities`'
`boardCount` subquery throw on every stage that already exists. A separate
optional key is the only shape that needs no data migration and cannot break a
legacy row.

Matching:

- `all` — the agent must hold every member
- `any` — the agent must hold at least one
- both present — both must hold
- `requires` present but empty after normalisation — falls back to `owner`

Every member is normalised with `capabilityTag` at the same four write
boundaries the single value already passes through, because routing is still
exact equality.

## S2 — The registry may say one capability implies another

`code-review` implies `code`. A new table, tenant-scoped:

```
capability_implications(tenant_id, implies_from, implies_to)
```

An agent's **effective** set is the transitive closure of its declared set.
Claim matches on the effective set; the Capabilities tab shows both, because a
diagnostic that counts effective holders while the operator sees declared ones
is a diagnostic that lies.

Cycles are permitted in storage and terminated in the closure walk — refusing
them needs a graph check on every write for a case that is harmless to survive.

## S3 — A capability carries A2A's own modality fields

`input_modes_json` / `output_modes_json`, defaulting to `[]`. These are
`AgentSkill.inputModes` / `outputModes` verbatim, continuing the rule that the
registry's columns are A2A field names so a card is a projection rather than a
translation.

**Stored and projected, not enforced.** Nothing validates a handoff against
them; that needs the DO and is out of scope. Recorded here so the next reader
does not mistake presence for enforcement.

## S4 — An agent projects an A2A AgentCard

`GET /v1/agents/:id/card` renders the agent's identity plus one `AgentSkill`
per capability it holds, read from the registry. A capability the agent holds
that the registry has somehow never seen still appears, degraded to its key —
the card describes the agent, and silently dropping a skill would make the card
disagree with the routing.

This is what naming the columns after `AgentSkill` was for.

## S5 — A near-duplicate is named at the moment it is created

Registering a capability returns the existing keys within edit distance 2, or
where one contains the other. **A hint, never a refusal** — the same reasoning
that reversed the declare/reference rule in `#56`: refusing dead-ends a real
first move, and this only ever catches the next typo.

## Out of scope, and why

| | why |
|---|---|
| fit scoring, reservation window | needs run history; the catalog has no `runs` table |
| `demonstrated` origin | same boundary |
| cross-board concurrency | same boundary — a real bug against the column's meaning, logged separately |
| federation / an OASF consumer | contradicts `decisions/2026-08-15-a-grant-names-an-agent-per-plane.md`; needs a decision record first |
| semantic matching on the claim path | deliberate refusal — exact equality's one virtue is that a failure is a string comparison anyone can run |
