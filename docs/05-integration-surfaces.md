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
  "action": "web.fetch", "parameter": {…}, "result": {…},        // for type=action
  "signal": "select", "signalMetadata": {…},                     // doc 04 §4
  "usage": { "inputTokens": 1200, "outputTokens": 300,
             "model": "claude-opus-4-8", "costUsd": 0.07 },       // optional metering
  "idempotencyKey": "…"
}
```
Adapters translate each harness's native stream into this envelope (see §6). Non-ephemeral
activities are the immutable record; `usage` feeds per-tenant metering ([07](./07-realtime-and-ui.md)).

## 2. MCP server surface

Kaambaan exposes a **remote MCP server over Streamable HTTP** at `/mcp`, so any MCP-capable
harness becomes a board worker.

- **Auth**: OAuth 2.1; Kaambaan is the **Resource Server**. Unauthenticated → `401` +
  `WWW-Authenticate` → client discovers `/.well-known/oauth-protected-resource` → PKCE flow →
  audience-validated bearer. **Validate the token audience; never pass tokens upstream.**
- **Session**: `Mcp-Session-Id` header; validate `Origin` (DNS-rebinding defense).
- **Tools** map 1:1 to contract verbs, with **honest annotations** so harnesses prompt humans
  correctly:

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
|------|:-:|:-:|:-:|
| `kaambaan_claim_card` | ✗ | ✗ | ✗ |
| `kaambaan_get_card` | ✓ | — | ✓ |
| `kaambaan_heartbeat` | ✗ | ✗ | ✓ |
| `kaambaan_post_activity` | ✗ | ✗ | ✗ |
| `kaambaan_request_input` | ✗ | ✗ | ✗ |
| `kaambaan_add_reference` | ✗ | ✗ | ✓ |
| `kaambaan_submit_for_review` | ✗ | ✗ | ✗ |
| `kaambaan_complete` | ✗ | ✗ | ✗ |
| `kaambaan_block` / `_release` / `_fail` | ✗ | ✓ | ✗ |

- **Business failures** return `isError: true` (model-visible, self-correctable), not transport
  errors. Transport errors are reserved for "tool not found"/bad args.
- **Elicitation**: when the agent's harness supports MCP **elicitation**, a `request_input` /
  gate can be surfaced as `elicitation/create` with a restricted flat schema and the
  `accept / decline / cancel` tri-state (see [08 — Reliability](./08-reliability-and-durable-execution.md)).
- We expose **tools only** (no MCP resources/prompts in v1) — matches what Claude Code / Copilot
  agents consume. **⚠️ OPEN**: expose board/card snapshots as MCP *resources* later.

### Implementation (P4)

The server is the official `@modelcontextprotocol/sdk` `McpServer` hosted over the SDK's
**Web-Standard Streamable HTTP transport** (`Request`→`Response`, native to Workers) in **stateless**
mode: every request gets a fresh server whose tools are thin RPC calls into the per-(tenant, board)
Board DO, so the only authority is the DO and there is no MCP-session state to keep in the Worker
(`apps/api/src/mcp/`). The tool handlers call the **same** `BoardStub` methods as the REST routes, so
the two surfaces are one contract — proven by `apps/api/test/mcp-parity.test.ts` (MCP ≡ REST).

- **Implemented tools**: `claim_card`, `get_card`, `heartbeat`, `post_activity`, `submit_for_review`,
  `complete`, `block`, `release`, `fail`. The agent's `{tenant, agentId, capabilities}` come from the
  token, never from tool arguments.
- **Deferred** (noted, not yet wired): `add_reference` (no reference model until **P5**) and
  `request_input` (MCP elicitation, rides with gate timeout/escalation in the deferred **P3.1**).
- **Auth (P4)**: the Resource Server validates a **dev bearer** —
  `Bearer <tenantId>:<agentId>:<comma-separated-capabilities>` — mirroring today's dev-mode
  `X-Tenant-Id`/`X-Agent-Id` headers, and serves RFC 9728 protected-resource metadata + the `401`
  challenge. **⚠️ OPEN**: a real Authorization Server (PKCE / dynamic registration via
  `@cloudflare/workers-oauth-provider`) is a fast-follow; only the token resolver changes.
- **⚠️ OPEN (P4 deferred)**: `Origin`/DNS-rebinding validation on the transport. Auth is a bearer
  (no ambient browser session to hijack), so the risk is low; it is wired when the real AS lands
  (`enableDnsRebindingProtection` + an allowlist derived from the deployed host).

**Connect Claude Code** to a running board worker (`pnpm --filter @kaambaan/api dev`) — see
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

| Verb | Endpoint |
|------|----------|
| claim | `POST /v1/boards/:boardId/claims` |
| getCard | `GET /v1/boards/:boardId/runs/:runId` *(as shipped — see "The agent read surface")* |
| heartbeat | `POST /v1/runs/:runId/heartbeat` |
| activity / requestInput | `POST /v1/runs/:runId/activities` |
| addReference | `PUT /v1/cards/:cardId/references` *(idempotent on url)* |
| submitForReview | `POST /v1/runs/:runId/submit` |
| complete / block / release / fail | `POST /v1/runs/:runId/{complete,block,release,fail}` |
| discover | `GET /.well-known/agent-card.json` · `GET /v1/boards` |

All mutating endpoints accept an `Idempotency-Key` header (see [08](./08-reliability-and-durable-execution.md)).

### Auth (as shipped)

An agent presents its token as `Authorization: Bearer kbn_…` (minted by "Connect an agent";
stored only as a SHA-256 hash in `agent_tokens`). The token carries the tenant, the agent identity
and the agent's registered capabilities, so the client never asserts them. `@kaambaan/agent-sdk`
speaks this by default — see [its README](../packages/agent-sdk/README.md). The dev-mode
`X-Tenant-Id` / `X-Agent-Id` headers only work against a server run with `DEV_AUTH=true`
([12](./12-deploy.md)).

Agent tokens authorize the **agent routes only** — `POST /v1/boards/:id/claims`,
`GET /v1/boards/:id/runs/:runId` and `POST /v1/boards/:id/runs/:runId/:action`. Board/card
administration is a human surface behind a session cookie.

### The agent read surface

`GET /v1/boards/:boardId/runs/:runId` is the whole of what an agent may read:

```jsonc
{
  "run":  { "runId", "cardId", "stageKey", "leaseEpoch", "status", "outcome", "startedAt", "endedAt" },
  "card": { …the claimed card… },
  "stage": { …the card's current stage… },
  "handoff": { …the upstream stage's handoff… },
  "references": [ …the card's external links… ]
}
```

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
- Events: `work.available` (a card the agent can claim entered a stage), `gate.resolved`,
  `run.reclaimed`, `card.canceled`.
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

- **⚠️ Best-effort today**: this slice is **at-most-once** — a `failed` delivery is terminal (not
  retried). Push is only an accelerator over the always-available pull path, so a dropped ping just
  means the agent learns of work on its next poll. **Durable transport** (Cloudflare **Queue** →
  **Workflow** with exponential backoff + retry caps) is the upgrade to at-least-once.
- **⚠️ Remaining**: events beyond `work.available` (`gate.resolved`, `run.reclaimed`,
  `card.canceled`); **URL ownership-verification** (the literal-IP denylist doesn't stop DNS
  rebinding — a host allowlist / challenge-response is the durable fix); auth on `push/dispatch` +
  `push/deliveries` when real auth replaces the dev headers.

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
