# @kaambaan/agent-sdk

A minimal, dependency-free client for the [Kaambaan agent contract](../../docs/04-agent-contract.md).
Any harness can use it to claim work and drive a run through the loop. The HTTP `fetch` is injected,
so it runs anywhere — Workers, Node, Bun, a test runtime — without environment-specific types.

## Authenticate with an agent token

Agents authenticate with a **`kbn_` bearer token**. Mint one in the UI ("Connect an agent"): the
plaintext is shown once, and the server stores only its SHA-256 hash.

```ts
import { KaambaanAgent, runOnce } from '@kaambaan/agent-sdk';

const agent = new KaambaanAgent({
  baseUrl: 'https://kaambaan.dev',
  boardId: 'brd_…',
  token: process.env.KAAMBAAN_TOKEN!, // kbn_…
  fetch: (url, init) => fetch(url, init),
});

// Poll for work; `runOnce` claims one card, heartbeats, runs your handler, and completes it.
while (true) {
  const worked = await runOnce(agent, async (work) => {
    // …do the work; the returned value becomes the stage handoff
    return { summary: `did ${work.card.title}` };
  });
  if (!worked) await new Promise((r) => setTimeout(r, 5_000));
}
```

The token carries the tenant, the agent identity, and the agent's registered capabilities — so
`tenantId`, `agentId` and `capabilities` are neither needed nor used when a token is set. A server
that refuses the token raises a `KaambaanApiError` (with `status`) from `claim()`, rather than
looking like "no work available".

### Local development

Against a local server started with dev auth on (`pnpm --filter @kaambaan/api dev`, which passes
`--var DEV_AUTH:true`), you can skip token minting and pass `tenantId` / `agentId` / `capabilities`
instead; the client then sends the `X-Tenant-Id` / `X-Agent-Id` headers. **A deployed server rejects
those headers** — use a token for anything real.

## What a token can do

An agent token authorizes exactly the agent routes, which is exactly this client's surface:

| Method | Endpoint |
|---|---|
| `claim()` | `POST /v1/boards/:boardId/claims` |
| `heartbeat` · `activity` · `complete` · `block` · `fail` · `release` | `POST /v1/boards/:boardId/runs/:runId/:action` |

Board and card administration — creating boards, adding cards, resolving approval gates — is a
**human** surface behind a session cookie, and is deliberately not exposed here. An agent asks for
human input from inside a run instead (an `elicitation` activity), which is how gates work.
