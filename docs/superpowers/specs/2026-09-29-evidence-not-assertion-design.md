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

Numbered in dependency order. Slice 0 was added on 2026-09-29 after the operator observed that
references will span far more providers than the enum names — Drive, Notion, Figma, Sentry — which
turned out to change slice 3's shape rather than merely its list.

### 0 — A provider registry, and a boundary that enforces it

`ReferenceProvider` is `z.enum(['github', 'gitlab', 'forge', 'docs', 'url'])`, and **nothing parses
it.** It appears in `verbs.ts` and `entities.ts`, and the routes cast request bodies rather than
parsing them (22 casts, 0 zod parses in `apps/api/src/index.ts`), so the enum is documentation. On
2026-09-28 `provider: "web"` was written to a live card and stored.

Which means references to Notion, Google Drive, Figma, Sentry or Linear already "work" today:
stored, unrecognised, no `externalId`, undedupable, and outside the enum that claims to constrain
them. The vocabulary is simultaneously **too narrow and not enforced** — the worst pair, because
the narrowness is visible and the non-enforcement is not.

So: a registry rather than an enum. Each provider brings a host pattern, a recogniser producing
`sourceType` and a durable `externalId`, and — see slice 3 — a **verification kind**. The
registry is the one place a new provider is added, and the write boundary parses against it, which
closes the `"web"` hole as a side effect rather than as a separate fix.

The registry ships with what exists (`github`, `gitlab`, `forge`) plus the generic `url`. `docs` is
removed: it is in the enum, produced by no recogniser and consumed by nothing.

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

### 3 — Live verification, where it means anything

The strongest requirement is *"this URL answers 200"* — the check that would have caught a board
reporting `published` over an unpushed commit.

**It is only a meaningful check for some providers, and this is the part that shapes the design.**
A Google Doc or a Notion page fetched without credentials returns a login page, frequently with
status **200**. A Drive file deleted last week would still "verify". For a feature whose purpose is
replacing assertion with evidence, that is the worst available failure: it manufactures false
confidence and calls it proof.

So a provider declares a **verification kind**, and permission is not the same question as
meaning:

| kind | providers | what a check proves |
|---|---|---|
| `fetch` | forge, github raw, a board's own published hosts | the artefact is there |
| `api` | Drive, Notion, Figma, Linear, Sentry | nothing without a credential — **not built here** |
| `none` | generic `url`, anything unrecognised | nothing |

Only `fetch` providers are verified, and only against an allowlist.

**D2 (decided): the allowlist has three sources.**

1. The tenant's `forge_host` — already configured and already validated as a bare host.
2. The registry's `fetch`-kind provider hosts: `github.com`, `api.github.com`,
   `raw.githubusercontent.com`, `gitlab.com`.
3. A per-board `verifyHosts`, because the check this exists for is `superjackfruit.com` — which is
   none of the providers. Without it, slice 3 cannot verify the one thing that failed twice.

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

**"Unverifiable" is the common answer, not the edge case.** Most providers an operator uses in
earnest — Drive, Notion, a customer's Jira — are `api` or `none`, so the honest result for most
references is that the board did not check. That is recorded on the run and printed in the receipt,
naming which of the three reasons applied: the provider cannot be checked this way, the host is not
allowlisted, or the check ran and passed. A silent pass would be indistinguishable from a real
verification, which is the whole failure this programme exists to end.

An `api`-kind verification — OAuth per provider, stored credentials, refresh — is a larger piece of
work than the rest of this spec combined and is deliberately **out of scope**. What belongs here is
the registry field that says a provider needs it, so the board can say "not checked, and here is
why" instead of "completed".

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
that — and only for `fetch`-kind providers on the allowlist, which will be the minority of the
references a working board accumulates.

It does not verify anything behind a login. Most of what an operator actually references — a Drive
document, a Notion page, a customer's ticket — cannot be checked without a credential, and a
fetch that returns somebody's login page with status 200 is worse than no check at all.

The aim is narrower and worth stating plainly: **the board should stop making claims it has not
checked.** Where it cannot check, it should say so rather than assert.

## Risk

This makes the board stricter, so runs that used to succeed will start blocking. That is the point,
and it will surface work on boards nobody is watching. Requirements are opt-in per stage, so the
blast radius is whatever an operator switches on.
