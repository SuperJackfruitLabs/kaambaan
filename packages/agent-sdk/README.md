# @kaambaan/agent-sdk

A minimal, dependency-free client for the [Kaambaan agent contract](../../docs/04-agent-contract.md).
Any harness can use it to claim work and drive a run through the loop. The HTTP `fetch` is injected,
so it runs anywhere — Workers, Node, Bun, a test runtime — without environment-specific types.

> **⚠️ You cannot install this.** The package is `private: true`, has no build step, and ships raw
> TypeScript — it is **not published to npm**, so nothing outside this repository can depend on it.
> Inside the repo it resolves as `workspace:*`. If you are integrating from elsewhere, read this
> README and `src/index.ts` as a worked example, then make the same HTTP calls yourself: the whole
> surface is nine endpoints, specified in [docs/05 §3](../../docs/05-integration-surfaces.md). The
> same applies to `@kaambaan/contract` — also private, also unpublished.

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
| `context()` | `GET /v1/boards/:boardId/runs/:runId` |
| `heartbeat` · `activity` · `complete` · `block` · `fail` · `release` | `POST /v1/boards/:boardId/runs/:runId/:action` |

`context(work)` re-reads what the claim already returned — the card this run holds, that card's
current stage, the upstream handoff and the card's references — for resuming after a restart or for
confirming where the card landed once the run has ended:

```ts
const work = await agent.claim();
if (work) {
  const { card, stage, handoff, references } = await agent.context(work);
}
```

That read is **run-scoped**: an agent reads a card because it claimed it. Another agent's run is a
`403`, and the whole-board snapshot is not agent-readable at all — a board is shared by a tenant's
agents, and one agent's work is not another's to read.

Board and card administration — creating boards, adding cards, resolving approval gates — is a
**human** surface behind a session cookie, and is deliberately not exposed here. An agent asks for
human input from inside a run instead (an `elicitation` activity), which is how gates work.

## Asking a human, and getting an answer

When the work needs a decision the agent may not take alone — a permission prompt, a choice between
paths — `ask()` puts the question on the card and parks it in `input-required`. **The run keeps its
lease**: the agent is waiting, not finished, and it resumes as itself rather than re-claiming.

```ts
const asked = await agent.ask(work, 'May I run the test suite?', {
  options: [
    { name: 'run_them', title: 'Run the tests' },
    { name: 'skip', title: 'Skip them' },
  ],
});

// Wait for a human, staying alive while you do.
for (;;) {
  await agent.heartbeat(work);
  const q = (await agent.elicitations(work)).find((e) => e.id === asked.id);
  if (q?.status === 'answered') break;      // q.answer = { option, text, answeredBy, answeredAt }
  if (q?.status !== 'pending') return;      // cancelled — the card moved on without you
  await new Promise((r) => setTimeout(r, 5_000));
}
```

Notes that matter in practice:

- **Options ride in `parameter`** — `ask()` puts them there for you. They are what the human clicks,
  and an answer comes back as the option's `name`.
- **Keep heartbeating.** A pending question does not pause the heartbeat timeout; an agent that goes
  quiet while waiting has its run reclaimed like any other, and its question `cancelled`.
- **The answer arrives on the run you already hold** (`GET /v1/boards/:id/runs/:runId`), so no human
  credential and no extra authorization are involved. Polling is the mechanism today; a push
  refinement would not change the shape of what you read.
- **You cannot answer your own question.** The answer route is a human surface, and the board
  refuses an answer from the agent that asked. Omit `options` for an open question — the human's
  free text comes back as `answer.text`.
