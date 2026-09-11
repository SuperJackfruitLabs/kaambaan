# `kbn` — kaambaan from a terminal

The third consumer of `@kaambaan/contract`, after the Worker's REST routes and its MCP server.
The contract's own comment states the rule this follows:

> Surface-neutral verb input/output schemas. The same schema validates a call whether it arrives
> over MCP or REST — there is exactly one contract.

`kbn` is a client. It adds no authority, validates no permissions locally, and renders the
board's own refusals.

## What it can do, and what it deliberately cannot

`kbn` authenticates with a **hub-issued token** — the same credential `apn fleet login` produces.
kaambaan verifies it offline against the hub's JWKS (`charter →
decisions/2026-08-15-one-issuer-and-offline-verification.md`), so one sign-in serves both planes.

That credential resolves as a **`member`**, and that is a decision rather than an oversight.
`auth/resolve.ts` says why:

> `member` rather than `owner`: the handoff exists so cards can be queued with authority, which
> is work. Managing this workspace's agents, its people and its fleet link are decisions for
> someone who is actually in it.

So `kbn` carries the **work** verbs — the board, its cards, its gates — and **not** the
management ones. Creating boards, staffing agents, editing the capability registry and changing
the fleet link all require a seat in the workspace, which a hub token does not grant.

That is the seat/post distinction in `charter → decisions/2026-09-03-role-is-a-seat-and-a-post.md`
arriving exactly where it was predicted to: a token that names a principal is not an account in
this workspace, and one is never inferred from the other.

**If management from a terminal is wanted**, the honest route is kaambaan issuing its own
credential to a CLI — its own authorization-code flow, the way the hub gained one — not widening
what a hub token means. That is a decision, not a feature.
