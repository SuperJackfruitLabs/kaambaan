# 05 — Integration Surfaces

The contract from [04 — Agent Contract](./04-agent-contract.md) is defined **once** (zod schemas
in `packages/contract`) and projected onto multiple wire surfaces. This doc specifies those
surfaces and how heterogeneous external harnesses connect.

```
                       packages/contract  (zod: verbs · activity envelope · A2A types)
                                  │  one definition, many projections
        ┌─────────────────┬───────┴────────┬──────────────────┬─────────────────┐
        ▼                 ▼                ▼                  ▼                 ▼
   MCP server        REST API        Outbound webhooks   Inbound triggers   Harness adapters
  (agents pull       (any service)   (push "work          (Slack / GitHub    (Claude Code,
   via tools)                          available")          issue / API)       Codex, OpenCode…)
```

## 1. The normalized activity envelope (shared by every surface)

Every harness reports progress in **one canonical typed shape**, so the board stays
domain-agnostic (a `tool_use` renders the same whether the agent codes, researches, or writes).
This merges our activity types (Linear), Vibe Kanban's `NormalizedEntry`
(`AssistantMessage / ToolUse / Thinking / ErrorMessage`), and the observability span-kind
consensus (OTel-GenAI / OpenInference).

```jsonc
{
  "runId": "run_…", "seq": 42, "ts": "2026-06-20T…Z",
  "type": "thought | action | response | elicitation | error",  // canonical (doc 04)
  "kind": "AGENT | LLM | TOOL | THINKING | MESSAGE | STAGE_TRANSITION", // render/observability hint
  "ephemeral": true,
  "body": "…",                          // markdown (message/thought)
  "action": "web.fetch", "parameter": {…}, "result": {…},        // args for type=action,
  "signal": "select",                          // …and a signal's payload: an elicitation's options
  "usage": { "inputTokens": 1200, "outputTokens": 300,
             "model": "claude-opus-4-8", "costUsd": 0.07 },       // optional metering
  "idempotencyKey": "…"
}
```
A signal's structured payload rides in **`parameter`** — there is exactly one carrier. (An earlier
draft showed a second field, `signalMetadata`; nothing ever read it, so an elicitation's options put
there were silently dropped and the human was shown a question with no answers to pick.)

Adapters translate each harness's native stream into this envelope (see §6). Non-ephemeral
activities are the immutable record; `usage` feeds per-tenant metering ([07](./07-realtime-and-ui.md)).

## 2. MCP server surface

Kaambaan exposes a **remote MCP server over Streamable HTTP** at `/mcp`, so any MCP-capable
harness becomes a board worker.

### Auth — what `/mcp` actually is (read this before building against it)

`/mcp` is an **OAuth 2.0 *Resource Server shell* over a bearer token**. It is not an OAuth 2.1
deployment, and an integrator who plans for one will build the wrong client.

**What exists.** An unauthenticated request gets `401` with
`WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`, and
that path serves RFC 9728 protected-resource metadata.

**What does not exist — anywhere in this repo.** There is no authorization server, no `/authorize`,
no `/token`, no dynamic client registration, no PKCE, no refresh tokens, no scope enforcement, and
**no audience**: nothing mints, carries, or validates an `aud` claim, and there are no JWTs at all
(the session cookie is a base64url+HMAC blob, not a JWT). Earlier drafts of this section described
that flow in the present tense. None of it was ever built.

**The two credentials `/mcp` accepts** (`apps/api/src/mcp/auth.ts`):

1. A **`kbn_` agent token** — the *same* credential as the REST surface, matched by SHA-256 hash
   against `agent_tokens`. This is the only credential that works against a deployed server.
2. A **dev bearer** `<tenantId>:<agentId>:<comma-separated-capabilities>` — accepted **only** when
   the server runs with `DEV_AUTH=true`. It is parsed, not verified: it asserts its own tenant,
   identity and capabilities with no secret involved. Local and test use only.

> **⚠️ The discovery chain dead-ends.** The metadata advertises `authorization_servers: [<origin>]`,
> and that origin serves no `/.well-known/oauth-authorization-server` and no `/authorize`. An MCP
> client that follows the `401` and tries to run the authorization flow **will fail at the next
> hop**. Configure your client with a `kbn_` token directly instead. A real Authorization Server is
> a fast-follow (**⚠️ OPEN**); until it lands, only the `401`-and-metadata shape is real.

- **Session**: none — the transport is **stateless** (`sessionIdGenerator: undefined`), so there is
  no `Mcp-Session-Id` acting as a credential. **⚠️ OPEN**: `Origin`/DNS-rebinding validation is not
  wired (auth is a bearer, so there is no ambient browser session to hijack).
- **Tools** carry **honest annotations** so harnesses prompt humans correctly. The eleven tools
  actually registered (`apps/api/src/mcp/tools.ts`), and how they line up with REST:

| Tool | Arguments beyond `boardId` | REST equivalent |
|------|---|---|
| `kaambaan_list_work` | *(none — no `boardId` either)* | **none** — MCP-only; `GET /v1/boards` is human-auth and has no `readyForYou` |
| `kaambaan_claim_card` | `maxConcurrency?` | `POST /v1/boards/:id/claims` *(REST also takes `profileKey`)* |
| `kaambaan_get_card` | `cardId` | **none** — there is no `GET …/cards/:cardId` |
| `kaambaan_add_reference` | `cardId`, `url`, `provider?`, `sourceType?`, … | `PUT …/cards/:cardId/references` *(human-auth — MCP is the only agent path)* |
| `kaambaan_heartbeat` | `runId`, `leaseEpoch` | `POST …/runs/:runId/heartbeat` |
| `kaambaan_post_activity` | `runId`, `leaseEpoch`, `type`, `body?`, `parameter?`, `signal?`, `usage?` | `POST …/runs/:runId/activities` |
| `kaambaan_submit_for_review` | `runId`, `leaseEpoch`, `output?` | `POST …/runs/:runId/`**`submit`** *(the verb is `submit`, not `submit_for_review`)* |
| `kaambaan_complete` | `runId`, `leaseEpoch`, `handoff?` | `POST …/runs/:runId/complete` |
| `kaambaan_block` / `_fail` | `runId`, `leaseEpoch`, `reason` *(required, non-empty)* | `POST …/runs/:runId/{block,fail}` *(REST defaults `reason` to `''`)* |
| `kaambaan_release` | `runId`, `leaseEpoch`, `reason?` | `POST …/runs/:runId/release` *(REST drops `reason`)* |

`{tenant, agentId, capabilities}` always come from the token, never from tool arguments.

> **⚠️ The one asymmetry that matters: MCP cannot read a run.** `GET /v1/boards/:id/runs/:runId` has
> **no MCP tool**, so an MCP-only agent cannot re-read its run — and therefore **cannot collect an
> elicitation answer** (§ "The elicitation return path" in [04](./04-agent-contract.md)), which
> arrives on that read. An agent that needs to ask a human a question must use REST for the
> collection half. `mcp-parity.test.ts` proves the verbs it covers agree across both wires; it does
> not establish that the two surfaces are equal in extent.

- **Business failures** return `isError: true` (model-visible, self-correctable), not transport
  errors. Transport errors are reserved for "tool not found"/bad args.
- **⚠️ OPEN — MCP `elicitation/create`**: surfacing a gate as a native MCP elicitation (restricted
  flat schema, `accept / decline / cancel` tri-state, see
  [08](./08-reliability-and-durable-execution.md)) is **not built**. Today a question travels as an
  `elicitation` activity and the answer is collected off the run read — a kaambaan-level mechanism,
  not an MCP protocol one.
- We expose **tools only** (no MCP resources/prompts) — matches what Claude Code / Copilot
  agents consume. **⚠️ OPEN**: expose board/card snapshots as MCP *resources* later.

### Implementation (P4)

The server is the official `@modelcontextprotocol/sdk` `McpServer` hosted over the SDK's
**Web-Standard Streamable HTTP transport** (`Request`→`Response`, native to Workers) in **stateless**
mode: every request gets a fresh server whose tools are thin RPC calls into the per-(tenant, board)
Board DO, so the only authority is the DO and there is no MCP-session state to keep in the Worker
(`apps/api/src/mcp/`). The tool handlers call the **same** `BoardStub` methods as the REST routes, so
where both surfaces expose a verb they cannot drift — `apps/api/test/mcp-parity.test.ts` asserts that
for the verbs it covers. It does **not** assert that the surfaces are equal in extent, and they are
not (see the run-read asymmetry above).

The tool list and the auth story are above, and are not repeated here. There is no
`kaambaan_request_input` tool: an agent raises an elicitation by posting an `elicitation` **activity**
through `kaambaan_post_activity`, which is also how it works over REST.

**Connect Claude Code.** Against a **deployed** board, the `Authorization` header is your `kbn_`
token (`"Bearer kbn_…"`, minted by "Connect an agent"). The example below uses the **dev bearer**,
which works only against a **local** worker started with `pnpm --filter @kaambaan/api dev` — see
[`apps/api/examples/claude-code.mcp.json`](../apps/api/examples/claude-code.mcp.json):

```jsonc
{
  "mcpServers": {
    "kaambaan": {
      "type": "http",
      "url": "http://localhost:8787/mcp",
      "headers": { "Authorization": "Bearer tnt_dev:agt_research:research,publish" }
    }
  }
}
```

## 3. REST surface

The A2A **HTTP+JSON** binding semantics — the same verbs as MCP, for any language/service that
doesn't speak MCP. Tokens are per-agent bearers (tenant + capability scoped).

**Every agent route is board-scoped.** There is no `/v1/runs/…` prefix — a run is always addressed
under its board. Earlier drafts of this table omitted the `/boards/:boardId` segment on every run
verb; those paths 404 or 405.

| Verb | Endpoint | Auth |
|------|----------|------|
| claim | `POST /v1/boards/:boardId/claims` | agent token |
| getCard | `GET /v1/boards/:boardId/runs/:runId` | agent token |
| heartbeat | `POST /v1/boards/:boardId/runs/:runId/heartbeat` | agent token |
| activity *(incl. raising an elicitation)* | `POST /v1/boards/:boardId/runs/:runId/activities` | agent token |
| submitForReview | `POST /v1/boards/:boardId/runs/:runId/`**`submit`** | agent token |
| complete / block / fail / release | `POST /v1/boards/:boardId/runs/:runId/{complete,block,fail,release}` | agent token |
| addReference | `PUT /v1/boards/:boardId/cards/:cardId/references` *(idempotent on `(cardId, url)`)* | **human session** — see below |
| answerElicitation *(human)* | `POST /v1/boards/:boardId/elicitations/:elicitationId/answer` | human session |
| resolve a gate *(human)* | `POST /v1/boards/:boardId/gates/:gateId/resolve` | human session |

An unknown `:action` on a run returns `404 {"error":"unknown run action: …"}`; anything else
unmatched under `/v1/boards` returns `405 {"error":"method not allowed"}`.

- **`addReference` is not on the agent REST surface.** The route is behind a session cookie, so an
  agent cannot call it over REST at all — `kaambaan_add_reference` over MCP is the only agent path to
  it. [04 §3](./04-agent-contract.md) lists `addReference` as an agent verb; over REST it is not one.
- **There is no `discover` verb.** `GET /.well-known/agent-card.json` **does not exist** — nothing
  serves an AgentCard. `GET /v1/boards` exists but is human-auth, so an agent token cannot list
  boards over REST either. Agents find work by calling `claim` (capability-routed), or over MCP with
  `kaambaan_list_work`, which is the only board-discovery surface an agent credential can reach.
- **⚠️ There is no `Idempotency-Key` handling.** No route reads such a header and nothing de-dupes a
  replayed verb; the `idempotencyKey` field in the contract schemas is accepted and ignored. Earlier
  drafts (and [08 §5](./08-reliability-and-durable-execution.md)) describe this as shipped — it is
  not. What *is* idempotent today is narrower and real: reference upsert on `(cardId, url)`, and
  GitHub webhook delivery dedup on `X-GitHub-Delivery`. Treat every other verb as at-most-once from
  the client's side: a retried `complete` after a timeout may act twice.

### Auth (as shipped)

An agent presents its token as `Authorization: Bearer kbn_…` (minted by "Connect an agent";
stored only as a SHA-256 hash in `agent_tokens`). The token carries the tenant, the agent identity
and the agent's registered capabilities, so the client never asserts them. The dev-mode
`X-Tenant-Id` / `X-Agent-Id` headers only work against a server run with `DEV_AUTH=true`
([12](./12-deploy.md)).

> **`@kaambaan/agent-sdk` is not a dependency you can take.** It is `private: true`, ships raw
> TypeScript with no build, and is **not published to npm** — nothing outside this repo can install
> it. [Its README](../packages/agent-sdk/README.md) is worth reading as a worked example of the loop
> below, but an external integrator implements these HTTP calls directly. The same is true of
> `@kaambaan/contract`: the zod schemas are the source of truth *inside* this repo, and a copy you
> vendor will not be kept in step with it.

**Error shapes differ by surface**, which is worth knowing before writing a client:

- REST board routes wrap the whole failed result: `{"error":{"ok":false,"code":"STALE_LEASE","message":"…"}}`
  — the code is nested at `error.code`.
- REST auth and routing failures are flat strings: `{"error":"a valid agent token is required"}`.
- MCP always returns HTTP 200 JSON-RPC; a business failure is `isError: true` with the body
  `{"error":{"code","message"}}` and no `ok` field.

Answering an elicitation is deliberately **not** an agent route: it is a human decision on a
tenant-shared board, so it sits behind the session cookie with gate resolution, and the board
refuses an answer from the agent that asked (`403 SEPARATION_OF_DUTIES`) on every surface — the same
rule that stops the producer of a gate approving it.

Agent tokens authorize the **agent routes only** — `POST /v1/boards/:id/claims`,
`GET /v1/boards/:id/runs/:runId`, `POST /v1/boards/:id/runs/:runId/:action` and
`GET /v1/boards/:id/gates/pending`. Board/card
administration is a human surface behind a session cookie, and a session cookie is *not* a
credential on the agent routes (a human moves work by moving a card or resolving a gate, never by
driving someone's run).

`gates/pending` is the one agent route that is **board-scoped rather than run-scoped**, and the
widening is deliberate. It exists for agentpod's reconciliation sweep (`charter →
decisions/2026-08-30-a-gate-closes-over-chat.md` §5): a `gate.pending` push retries five times and
then dead-letters, and a gate nobody was told about blocks a card indefinitely with neither side
looking. The board snapshot carries the same gates and is a human route — reaching it would have
meant the bridge minting an assertion for a person on a timer, which is a much larger thing to
allow than a read. It names no one, carries no authority, and resolves nothing: **an agent that can
see a gate still cannot answer one**, which stays a human decision behind the session cookie or a
hub-issued assertion for a real person.

Within the tenant, a token reaches **its own runs**: the authenticated agent is compared against
`run.agentId` on every run verb and on the run read ([04 §1](./04-agent-contract.md)), so
`{runId, leaseEpoch}` is not a bearer capability — `403 NOT_RUN_OWNER` on another agent's run,
distinct from the `409 STALE_LEASE` that means "your lease lapsed, re-claim". Both wires enforce it:
the MCP tools pass the token's agent into the same Board DO methods.

### The agent read surface

`GET /v1/boards/:boardId/runs/:runId` is the whole of what an agent may read **about work** —
`gates/pending` above is the only other read, and it is about approvals rather than runs:

```jsonc
{
  "run":  { "runId", "cardId", "stageKey", "leaseEpoch", "status", "outcome", "startedAt", "endedAt" },
  "card": { …the claimed card… },
  "stage": { …the card's current stage… },
  "handoff": { …the upstream stage's handoff… },
  "references": [ …the card's external links… ],
  "elicitations": [ …the questions this run asked, each with its answer once given… ]
}
```

`elicitations` is also **how a blocked agent gets unblocked**. An agent that asks a question
(`activity` type `elicitation`) keeps its lease and polls this same read until its question turns
`answered`; the answer arrives with no human credential and no second authorization rule, because
the run it already holds is the thing being read. A card that moves on without an answer marks the
question `cancelled` — a signal to stop waiting. Push (a WebSocket or a `work.available`-style
webhook) can shorten the wait later; it does not change who may read what.

It is **run-scoped, not board-scoped**, and authorized by the same predicate as the run verbs — *a
run belongs to the agent that claimed it* — so there is one ownership rule, not two:

- an agent reads a card **because it claimed it**, never by naming one (403 `NOT_RUN_OWNER` on
  another agent's run, 404 on an unknown one);
- no lease is required, so a finished run stays readable and an agent can confirm where its card
  landed (a reclaimed agent sees it lost the card);
- the whole-board snapshot (`GET /v1/boards/:id`) — every card, every gate, board-wide cost and the
  GitHub config — stays **human-only**, as does listing boards or cards. A board is shared by a
  tenant's agents; one agent's spec, handoff and output are not another's to read, and an agent
  cannot enumerate the board it works on.

Agents find work through `claim` (capability-routed) rather than by browsing, so a read surface
wider than "the run I hold" would buy nothing and leak across every agent in the tenant.

## 4. Outbound webhooks (push dispatch)

Pull is the default ([04 §3](./04-agent-contract.md)); push is an **accelerator** that just tells
an agent to call `claim`. Modeled on A2A **PushNotificationConfig**:
- Config: `{ url, token, authentication: { schemes: ["Bearer"], credentials } }`, registered per
  agent/board.
- Events: `work.available` (a card the agent can claim entered a stage), `gate.pending` (a card
  is waiting on a human's approval), `gate.resolved`, `run.reclaimed`, `card.canceled`.
- **Delivery is durable**: enqueued to a **Queue**, delivered by a **Workflow** with retries +
  exponential backoff; each delivery is **HMAC/JWT-signed**; the receiver verifies and may then
  `claim`. SSRF defense: webhook URLs are allowlisted/ownership-verified.

### Implementation (P7)

The Board DO owns the subscriptions and the delivery queue. `registerPushConfig({agentId, url, token,
capabilities, events})` stores a config (http(s)-only — the SSRF guard; `POST …/push-configs`). When a
card becomes **claimable** (created at / advanced into / released or reclaimed back to a
capability-owned stage), `notifyWorkAvailable` queues a `work.available` delivery into `push_deliveries`
for every subscribed config whose `capabilities` match the stage's owner — so an agent is only pinged
about work it could actually claim. `dispatchPushDeliveries(sender)` drains pending rows, **signs each
body** (`X-Kaambaan-Signature: sha256=…`, HMAC over the exact bytes — shared with the inbound GitHub
verifier, `src/crypto/hmac.ts`) and POSTs it (`src/push/deliver.ts`), marking each sent/failed.
`POST …/push/dispatch` triggers a drain; `GET …/push/deliveries` inspects the queue. URLs are checked
against an **SSRF denylist** (`src/push/ssrf.ts` — only public http(s); blocks localhost, loopback,
RFC1918, link-local/169.254 metadata, IPv6 ULA/link-local).

- **At-least-once, within a cap.** A `failed` delivery is retried: the drain re-picks rows in
  `status IN ('pending','failed')` while `attempts < MAX_PUSH_ATTEMPTS` (5), and an exhausted row
  is dead-lettered to `status = 'dead'` rather than deleted, so a delivery nobody could receive
  stays visible in `GET …/push/deliveries`.
- **The alarm drains the queue** (`alarm()` → `dispatchPushDeliveries`), with backoff doubling
  from `PUSH_DRAIN_BASE_MS` (5s) off the least-tried pending row: 5s, 10s, 20s, 40s, 80s. The DO
  has one alarm and two jobs, so `scheduleReclaim` sets whichever of the reclaim deadline and the
  next drain comes first — the later job must never cancel the earlier one.

  > **Corrected 2026-08-30.** This section previously said the slice was *"at-most-once — a
  > `failed` delivery is terminal (not retried)"*. Retry and dead-lettering were already built;
  > the doc had not caught up. The real gap was narrower and worse: `dispatchPushDeliveries` was
  > reachable **only** from `POST …/push/dispatch`, so nothing drained the queue unattended and a
  > queued delivery sat pending until something outside the board poked it. Survivable for
  > `work.available`, which has pull underneath it; not survivable for `gate.pending`, which has
  > nothing underneath it — a gate that never rings is a card blocked forever on an approval
  > nobody was asked for. Found while implementing
  > `charter → decisions/2026-08-30-a-gate-closes-over-chat.md`.

- **⚠️ Remaining**: events beyond `work.available` and `gate.pending` (`gate.resolved`,
  `run.reclaimed`, `card.canceled`); **URL ownership-verification** (the literal-IP denylist
  doesn't stop DNS rebinding — a host allowlist / challenge-response is the durable fix); auth on
  `push/dispatch` + `push/deliveries` when real auth replaces the dev headers. **Durable transport**
  (Cloudflare **Queue** → **Workflow**) remains the heavier upgrade; the alarm above buys the same
  at-least-once property for a fraction of it.

**`gate.pending` fan-out is by subscription only**, deliberately unlike `work.available`. That one
asks *who could claim this stage* and matches on capability; a gate asks *who owns this card*, and
its owner is a human. Copying the capability match would deliver approval requests to whichever
agents advertise the review stage's capability — and, because a review stage is human-owned, to
nobody at all.

## 5. Harness adapters (the "any harness, anywhere" layer)

Every harness exposes the same capabilities behind one **adapter interface** — the wire-level
analog of Vibe Kanban's `StandardCodingAgentExecutor`:

| Adapter capability | Meaning |
|---|---|
| `start(card, context)` | Begin a run for a claimed card with the self-contained context bundle |
| `followUp(message, resume?)` | Send human feedback / gate decision into a live run (optionally resume from a point) |
| `applyProfile(profile)` | Apply model/permissions/autonomy overrides (see §7) |
| `normalizeEvents(native) → envelope[]` | Translate the harness's native stream into §1 envelopes |
| `capabilities()` | Advertise skills/models (its A2A AgentCard) |
| `availability()` | Is it installed/authenticated/online |

**ACP alignment.** The [Agent Client Protocol](https://agentclientprotocol.com) is already spoken
by Gemini CLI, Copilot CLI, and Qwen; we treat ACP as a **first-class native transport** an
adapter can wrap, alongside MCP-client and REST. **⚠️ OPEN**: ship an ACP bridge in v1 vs
fast-follow.

### Per-harness connection guide

| Harness | How it connects | Notes |
|---|---|---|
| **Claude Code** | Remote **MCP client** in `.mcp.json` (`type:"http"`, `url`, `headers`/`headersHelper`); run headless `claude -p --input-format stream-json --output-format stream-json` | Strongest fit; dynamic per-task auth headers; `normalizeEvents` parses `stream-json` |
| **OpenAI Codex** | Remote MCP via `experimental_use_rmcp_client=true` + `[mcp_servers.kaambaan]` (`url`, `bearer_token_env_var`); run `codex exec --json` | NDJSON event stream; per-task header injection rougher |
| **OpenCode** | Remote MCP in `opencode.json`; **native REST/SSE** via `opencode serve` (`/session`, `/global/event`) | Can drive over REST without MCP at all |
| **Cloudflare Agents** | Hosts MCP client *and* REST/webhook listener; `addMcpServer(url,{headers})` | The natural webhook/REST front-end + MCP hub for the others |
| **Any (REST)** | Poll `claim`, post activities/heartbeats, complete | Lowest common denominator; works everywhere |

A thin **reference worker** (a Cloudflare Agent) ships in v1 to prove the loop and serve as the
copy-paste starting point for operators.

## 6. Inbound triggers — many sources, one Task path

Convergent industry pattern (Devin/Factory/Cursor/Copilot): **`@mention` or label/assignment on
an existing tracker → a task.** Kaambaan models every trigger as an **adapter that funnels into one
`createCard` path**, attaching the originating resource as a reference + context:

- **API/SDK** — `POST /v1/boards/:id/cards`.
- **GitHub issue** — issue labeled/assigned → card created, issue attached as a reference
  ([06](./06-external-references.md)).
- **Slack** — `@kaambaan <task>` → card created in a default board.
- **Webhook** — generic inbound.
- **Schedule** — recurring cards via a Workflow cron.

No source is special-cased; each just produces a card with provenance.

**Implementation (P7)**: the funnel is `createCardFromTrigger({title, ownerUserId, source})` — create a
card and attach the originating resource as a reference (`apps/api/src/board/board-do.ts`). Wired:
**API** (`POST …/triggers` — the generic inbound path) and **GitHub issue** (`issues.opened` →
card+reference when `issueTrigger` is enabled via `PUT …/github`). **⚠️ Remaining**: Slack
(`@kaambaan` — needs the Slack app from P7's notifications gap) and Schedule (a Workflow cron); both
reuse the same funnel, only the adapter differs.

## 7. Agent profiles (configuration as data)

A **profile** is a reusable, named bundle: `{ harness, model, permissionPolicy, autonomyLevel,
capabilities }` (Vibe Kanban variants × Factory autonomy levels). Profiles are tenant-scoped,
editable via GUI **and** as a checked-in JSON file, and selected when an agent claims / when a
stage dispatches. An **Attempt** ([03](./03-card-lifecycle.md) / [07](./07-realtime-and-ui.md))
pins the profile it ran under, so re-running a card under a *different* profile is a first-class,
comparable operation.

**Implementation (P7)**: profiles are board-scoped data — `setProfile({key, harness, model,
permissionPolicy, autonomyLevel, capabilities})` / `getProfiles` (`GET/POST …/profiles`). `claim`
accepts a `profileKey`, recorded on the run, so the **attempt pins its profile** (surfaced in the
attempts comparison). Per-stage routing is a `StageDef.routing` field (`pipeline` | `manager`,
default pipeline). **⚠️ Remaining**: **tenant-scoped** profiles + the checked-in-JSON/GUI editing
surface (this slice is per-board); enforcing `permissionPolicy`/`autonomyLevel` at dispatch; and the
**manager** routing *behavior* (the field round-trips today; a manager agent orchestrating sub-agents
is a follow-up). Additional harness adapters (Codex NDJSON, OpenCode SSE, ACP bridge) follow the
Claude `normalizeEvents` pattern (docs/07 §1) once their wire formats are pinned.
