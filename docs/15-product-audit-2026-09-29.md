# Product audit — 29 September 2026

An audit of superpipeline as an operated product: the API, the CLI, the web app, the contract
package, authorization, the reliability machinery, and the integration surface. Written after a
week of running the Press board for real, where the friction below was met rather than imagined.

**Scope note.** This is a point-in-time review, not a specification. Where it recommends a change
it says so; where it records a strength it says that too, because an audit that lists only faults
gives no sense of what is worth protecting.

## Verdict

A well-built product with a thin and uneven operator surface.

The engine is disciplined. Three debt markers across 195 TypeScript files. 105 test files. Leases
with fencing epochs and a Durable Object alarm that reclaims a lapsed run. A WebSocket feed that
reconnects rather than showing "offline" until reload. Agent scopes that are checked rather than
recorded. A [`docs-check`](../packages/docs-check/README.md) package that fails CI when the docs
name something the code does not have.

Almost everything below is at the edges.

The operator complaints that prompted this — *"trouble accessing the work, reading agent logs,
discovering settings"* — are three symptoms of one cause: **the board models work, but not the
artefacts of work, and it exposes what it does model through a CLI that only speaks JSON.**

## Critical

### 1. Forge does not exist in the model

`ReferenceProvider` is a closed enum — `['github', 'gitlab', 'docs', 'url']`
(`packages/contract/src/primitives.ts:119`). There is no Forgejo anywhere in the codebase.

The charter made forge primary for repositories. The tool that coordinates work on those
repositories cannot name where they live. A forge pull request degrades to a generic `url`
reference with no `externalId`, so it cannot be deduped, enriched, or synced, and the board cannot
tell a forge PR from a link to a blog post.

The integration is GitHub-shaped end to end: `PUT /v1/boards/:id/github`,
`POST /v1/boards/:id/webhooks/github`, and `apps/api/src/references/reference-url.ts`.

### 2. The contract is not a boundary

`apps/api/src/index.ts` contains **22 request-body casts and zero zod parses**. It imports
`capabilityTag`, `capabilityTags` and `stageRequiredCapabilities` from `@superpipeline/contract` —
helpers, never schemas.

Validation is therefore hand-rolled per route, and its quality tracks how much attention that
route happened to receive. `POST /claims` checks its body carefully, field by field. `PUT
…/references` does not check at all: `ReferenceArgs.provider` is typed `string`, so a provider
outside the enum is accepted and stored. That is not hypothetical — `provider: "web"` was written
to a live card on 2026-09-28.

The same gap let `stage.instructions` travel from `set-stages` through the run context and into an
agent's prompt for several hours with nothing anywhere declaring the field. It worked by accident,
which is a worse state than not working.

The team has already met this class and fixed one instance. From `apps/api/src/index.ts:889`:

> The assertion `as { name: string; stages: StageDef[] }` promised the compiler two fields the
> request had no obligation to carry, and the first caller to get it wrong — `{"name": "…",
> "template": "software"}`, which is what a reasonable person types — reached `[...board.stages]`
> inside the Durable Object and got **HTTP 500 `board.stages is not iterable`**.

Twenty-one casts remain.

### 3. Artefacts have no representation

The board records *activities* — action names, file paths, responses — and never the thing
produced. An activity reading `read_file: /root/.hermes/profiles/research-ray/brief.md` names a
path on a machine the board cannot reach and the operator cannot open.

Retrieving one brief on 2026-09-28 took: a hand-built `curl` against
`/cards/:cardId/activities`, a guess at which station had run the stage, an SSH session to that
host, and a filesystem search — because the draft was not where the first three guesses looked.

This is the root of "cannot access the work". It is a modelling gap, not a UI gap, and no amount
of CLI work closes it.

## High

### 4. The CLI is a JSON pipe, missing its most-needed verbs

`out()` is unconditionally `JSON.stringify(value, null, 2)` (`packages/cli/src/index.ts:140`).
The `--json` flag is consumed by exactly one command, `whoami`, while the help text advertises it
as *"machine-stable output, on any command"* — which implies a default human format that does not
exist. Every board, card and gate interaction is raw JSON.

More seriously, **a gate cannot be resolved from a terminal.** `supi gates` lists what is waiting;
`POST /v1/boards/:id/gates/:gateId/resolve` has no CLI verb. Approval exists only in supermessage
and the web app.

The API exposes 39 routes. `supi` exposes roughly 13 operations. Absent: the activity log, run
attempts, board events, usage and spend, notifications, and a single run's context. `supi card`
requests `GET /v1/boards/:id/cards/:cardId`, a route that has never existed, and has therefore
never worked (issue #90).

### 5. Settings are unreachable or scattered

`stage.instructions` appears in **no UI** — `BoardSettings.svelte` edits `key`, `name`, `order`,
`owner`, `ownerKind`, `requires`, `gate` and `wipLimit`, and not this — and has **no CLI
command**. The only way to set a stage's standing rule is to hand-build a complete pipeline JSON
and call `set-stages`.

`set-stages` replaces the whole pipeline. Changing one field on one stage means reading every
stage, mutating one, and writing them all back; any concurrent edit is lost. This was done four
times in one afternoon while configuring one board.

Board configuration is otherwise split with no index: the pipeline editor at `/b/:id/settings`,
budget caps deliberately moved to Operate › Spend, and `github`, `push-configs`, `triggers` and
`profiles` reachable by API with no obvious home in either client.

### 6. Two routing fields, one silently wins

The stage editor presents `owner` and `requires` side by side. `stageCapabilitiesMet`
(`packages/contract/src/primitives.ts:215`) uses `requires` when it is present and ignores `owner`
entirely, falling back to `owner` only when `requires` is absent.

A stage displaying `owner: claim-check` alongside `requires: {any: [claim-check, analysis]}` routes
on the requirement; the owner is decoration. Nothing in either client says so.

## Medium

### 7. Decided gates are absent from the board snapshot

The snapshot carries `pendingGates` only. `gatesForCard` — every gate including resolved ones,
with decider and comment — exists in `board-do.ts` and no read shape uses it.

A published run receipt built from the board snapshot therefore recorded a human approval that had
happened as no approval at all.

### 8. Operational constants are not configurable

`HEARTBEAT_TIMEOUT_MS` (15 minutes) and `CIRCUIT_BREAKER_LIMIT` (2) are module constants in
`board-do.ts`, both marked `⚠️ OPEN` against [docs/08](./08-reliability-and-durable-execution.md).
Pricing carries the same marker. They apply board-wide, so a research stage that thinks for twenty
minutes and a publish stage that runs for thirty seconds are held to one tolerance.

### 9. The webhook route selects a tenant without authentication

`POST …/webhooks/github` takes `?tenant=` from the query string before any credential is checked.
Cross-tenant writes are prevented — a wrong tenant addresses a different Durable Object holding a
different secret, and the HMAC fails — but an unauthenticated caller can still cause arbitrary
`(tenant, board)` Durable Objects to be instantiated.

## Forge integration

Four pieces, and smaller than it appears, because Forgejo's webhook payloads are largely
Gitea- and GitHub-shaped and much of the existing handler is reusable.

1. **Add `forge` to `ReferenceProvider`**, with a migration for rows already stored as `url`.
2. **Generalise `recognizeReference`.** This is the real design wrinkle: it hardcodes `github.com`,
   and a self-hosted forge is instance-specific. Recognition needs *configured hosts* rather than a
   constant, which is a different shape from what is there now.
3. **`PUT /v1/boards/:id/forge` and `POST /v1/boards/:id/webhooks/forge`**, reusing the HMAC
   verification and delivery-deduplication path.
4. **Stop a forge reference and a GitHub one colliding.** This entry was written the wrong way
   round and is corrected here rather than quietly reworded: it said a forge pull request and its
   GitHub mirror are *the same work* and would produce duplicates. They are not. A push mirror
   mirrors git refs, **not** pull requests, so forge PR #7 and GitHub PR #7 on a mirrored
   repository are different objects that happen to share an id — and `externalId` is `owner/repo#n`
   for both, matched with no provider filter. The risk was never duplication; it was a delivery
   from one provider writing its state onto the other's reference. Fixed by qualifying every
   matcher with the provider.

## Recommended sequence

**First — the daily friction.** `supi gates approve|reject`, a human-readable default output with
`--json` as the opt-in the help already promises, `supi log <cardId>`, and a per-stage patch so a
stage rule can be set without rewriting the pipeline.

**Then — forge.** Items 1 to 4 above. Item 2 is the one to design rather than pattern-match.

**Then — artefacts as first-class references.** Per-card branches, adopted on the Press board on
2026-09-29, are the first half: they give every stage's output a URL. The second half is the board
holding that URL as a reference, so "what did this stage produce" is answerable from the board.

**Throughout — parse request bodies with the contract schemas at the route boundary.** This retires
a bug class rather than instances of it, and it is the single change that would have prevented
findings 2 and much of 5.
