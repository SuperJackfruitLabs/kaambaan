# Evidence, not assertion — design

**Status:** approved in outline (D1–D3 decided 2026-09-29); slices unbuilt.

A stage can say what finishing means, and the board checks it before believing an agent.

## The problem, from a real card

`complete()` writes `outcome = 'completed'` and advances the card **unconditionally**
(`board-do.ts`). The handoff is stored verbatim and never inspected. An agent calling `complete`
is the sole author of the claim that its stage is done.

On the one card that has run this board end to end, that claim was false twice:

- `publish` reported success over a commit sitting unpushed on a station. The board said
  `published`. Nothing was published.
- `publish` reported `completed` for a run that **explicitly refused to publish**, because the
  agent finished its turn rather than calling `block`.

The published receipt — the artefact whose entire purpose is making the process checkable —
records `publish · coder-kai · completed` for the run that refused. It is faithfully reporting a
board that recorded a falsehood.

The first was patched with a stage rule; the second with another. Both are **advisory**, and the
pattern of this whole programme is that advisory loses: the `insteadOf` rewrite held because git
enforced it, and every failure that mattered came from something a person or an agent was merely
told to do.

**Nothing new is needed in the vocabulary.** `RunOutcome` already carries `blocked`, and `block()`
already records it. What is missing is that `complete` is unconditional. It should be **earnable**.

## Slices

### 1 — Stage completion requirements

A stage declares what a run must produce. `complete()` evaluates it against the handoff and the
card's references. Unmet, the run ends `blocked` with the reason and the card does **not** advance.

```jsonc
// on a stage, beside `instructions`
"completion": {
  "handoff": ["url", "commit"],          // keys that must be present and non-empty
  "reference": { "provider": "forge" },   // a reference of this kind must exist on the card
  "live": "url"                           // slice 3: that handoff key must answer 200
}
```

Every arm optional; an absent `completion` behaves exactly as today, so no existing board changes
behaviour on deploy.

**D1 (decided): a failed check BLOCKS.** Not `failed`, which invites a retry loop burning budget
on the same untrue claim. The agent asserted something that was not so; a person should see it.
The block reason names the specific arm that failed, because "completion check failed" sends
somebody to read code.

### 2 — Artefacts as first-class references

The most useful requirement is *"you produced a thing — here it is."* Per-card branches
(2026-09-29) already give every artefact a URL; the board does not hold one. An agent attaches a
reference as part of finishing, and a stage may require one of a given kind.

This closes the structural gap named in `../../15-product-audit-2026-09-29.md`: the board records
that work happened and nothing about what was produced, so an activity naming
`/root/.hermes/profiles/research-ray/brief.md` points at a machine the reader cannot reach.

### 3 — Live verification

The strongest requirement is *"this URL answers 200"* — the check that would have caught a board
reporting `published` over an unpushed commit.

**D2 (decided): an allowlist, from three sources.**

1. The tenant's `forge_host` — already configured and already validated as a bare host.
2. Fixed provider hosts: `github.com`, `api.github.com`, `raw.githubusercontent.com`,
   `gitlab.com`. **Not** `docs` — it is in `ReferenceProvider`, produced by no recogniser and
   consumed by nothing, so allowlisting it allowlists nothing. **Not** `url`, which is by
   definition the category everything unrecognised falls into.
3. A per-board `verifyHosts`, because the check this exists for is `superjackfruit.com` — which is
   none of the above. Without it, slice 3 cannot verify the one thing that failed twice.

**Refused regardless of the list:**

- non-`https` schemes — no `http`, `file:`, `data:`
- literal IP hosts, and anything resolving to loopback, RFC1918 or link-local — `169.254.169.254`
  most of all
- **a redirect that leaves the allowlist.** The one usually missed: an allowlisted host can `302`
  to a private address, so a redirect off-list is refused rather than followed and judged after
- a timeout and a response size cap, so a slow or enormous reply cannot stall the five-minute
  sweep that shares this Worker

Workers' `fetch` does not run on a VM carrying instance metadata, so the classic metadata attack is
weaker here than on EC2. Weaker is not absent, and none of the above leans on it.

A host outside the list is **unverifiable, not failing**: the run completes and the trace records
that the live check was skipped and why. Treating "we may not look" as "it is broken" would make
the allowlist a denial-of-service on the operator's own boards.

### 4 — Make a refusal read as one

A blocked run reads as blocked in the drawer, in `supi log`, and in the receipt. Today the receipt
carries a note explaining that a repeated stage usually means an earlier run finished without
doing the work — a caveat written because the board could not say so itself. With slice 1 shipped
that note is deleted, and the trace says `blocked` where the board says `blocked`.

## Card overrides

**D3 (decided): a card may override its stage's requirement** — `card.spec.completion`, same shape,
replacing the stage's rather than merging with it.

**An override is recorded.** It is exactly the mechanism for routing around an inconvenient check,
so the answer is not to forbid it but to make it impossible to do quietly: the run records that it
ran under an override, and the receipt prints it. A check that can be waived invisibly is not a
check.

## What this does not do

It does not make an agent honest. An agent that writes `{"url": "https://example.test"}` into a
handoff satisfies a structural requirement while having done nothing, and only slice 3 catches
that — and only for hosts on the list.

The aim is narrower and worth stating plainly: **the board should stop making claims it has not
checked.** Where it cannot check, it should say so rather than assert.

## Risk

This makes the board stricter, so runs that used to succeed will start blocking. That is the point,
and it will surface work on boards nobody is watching. Requirements are opt-in per stage, so the
blast radius is whatever an operator switches on.
