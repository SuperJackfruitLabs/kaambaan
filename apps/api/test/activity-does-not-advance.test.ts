import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { createAgent, createAgentToken } from '../src/db/catalog';
import { deriveStateFromActivity } from '@kaambaan/contract';

/**
 * What a `response` / `error` activity actually does to a card (docs/04 §4).
 *
 * The specs said `response` "drives state to `completed`" and `error` to `failed`. The board does
 * neither: `postActivity` moves the card for exactly one activity type, `elicitation`. An agent that
 * posts a terminal `response` and disconnects leaves its card `working` until the heartbeat timeout
 * reclaims it — which is a silent, expensive way to lose work, and is why this is pinned here.
 *
 * The contract *does* export `deriveStateFromActivity()` mapping response→completed, with passing
 * unit tests — but no production code calls it. That is the failure mode this file exists to close:
 * a claim tested in isolation, far from the code that would have to honour it.
 */

beforeAll(setupCatalog);

const base = 'https://api.test';

const STAGES = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'build' },
];

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** A human sets the board up; agent tokens cannot create boards or cards. */
async function setupBoard(tenantId: string) {
  const boardRes = await SELF.fetch(`${base}/v1/boards`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Activity semantics', stages: STAGES }),
  });
  expect(boardRes.status).toBe(201);
  const boardId = ((await boardRes.json()) as { boardId: string }).boardId;

  const cardRes = await SELF.fetch(`${base}/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Summarize the incident reports', ownerUserId: 'usr_a' }),
  });
  expect(cardRes.status).toBe(201);

  const agent = await createAgent(env.DB, tenantId, { name: 'Researcher', capabilities: ['research'] });
  const { token } = await createAgentToken(env.DB, tenantId, agent.id, ['claim']);

  const claimRes = await SELF.fetch(`${base}/v1/boards/${boardId}/claims`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({}),
  });
  expect(claimRes.status).toBe(200);
  const work = (await claimRes.json()) as { claimed: boolean; runId: string; leaseEpoch: number };
  expect(work.claimed).toBe(true);
  return { boardId, token, ...work };
}

function postActivity(boardId: string, runId: string, token: string, body: Record<string, unknown>) {
  return SELF.fetch(`${base}/v1/boards/${boardId}/runs/${runId}/activities`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify(body),
  });
}

/** Read the card back the way an agent can: off the run it holds. */
async function cardOf(boardId: string, runId: string, token: string) {
  const res = await SELF.fetch(`${base}/v1/boards/${boardId}/runs/${runId}`, { headers: auth(token) });
  expect(res.status).toBe(200);
  return (await res.json()) as { card: { state: string; currentStageKey: string }; run: { status: string } };
}

describe('an activity does not advance the card — only a verb does', () => {
  it('records a `response` without completing the stage', async () => {
    const { boardId, runId, leaseEpoch, token } = await setupBoard('tnt_act1');

    const res = await postActivity(boardId, runId, token, {
      leaseEpoch,
      type: 'response',
      body: 'Here is the summary you asked for.',
    });
    expect(res.status).toBe(200);
    // The route reports the card state it left behind, and it is still `working`.
    expect(await res.json()).toMatchObject({ activity: { accepted: true, cardState: 'working' } });

    const { card, run } = await cardOf(boardId, runId, token);
    expect(card.state, 'a `response` must not complete the card').toBe('working');
    expect(card.currentStageKey, 'and must not advance the stage').toBe('research');
    expect(run.status, 'the run is still live — the agent still holds its lease').toBe('working');
  });

  it('records an `error` without failing the stage', async () => {
    const { boardId, runId, leaseEpoch, token } = await setupBoard('tnt_act2');

    const res = await postActivity(boardId, runId, token, { leaseEpoch, type: 'error', body: 'the fetch blew up' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ activity: { accepted: true, cardState: 'working' } });

    const { card } = await cardOf(boardId, runId, token);
    expect(card.state, 'an `error` activity must not fail the card').toBe('working');
  });

  it('moves the card only when the agent calls the verb', async () => {
    const { boardId, runId, leaseEpoch, token } = await setupBoard('tnt_act3');

    await postActivity(boardId, runId, token, { leaseEpoch, type: 'response', body: 'done, I think' });
    expect((await cardOf(boardId, runId, token)).card.state).toBe('working');

    const done = await SELF.fetch(`${base}/v1/boards/${boardId}/runs/${runId}/complete`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ leaseEpoch, handoff: { summary: 'the incidents, summarized' } }),
    });
    expect(done.status).toBe(200);

    // The run read stays available after the run ends, so the agent can confirm where its card went.
    const { card, run } = await cardOf(boardId, runId, token);
    expect(run.status, 'complete ends the run').toBe('ended');
    expect(card.currentStageKey, 'and advances the card — this is the only thing that does').toBe('build');
  });

  it('an `elicitation` is the one activity that does move the card', async () => {
    const { boardId, runId, leaseEpoch, token } = await setupBoard('tnt_act4');

    const res = await postActivity(boardId, runId, token, {
      leaseEpoch,
      type: 'elicitation',
      body: 'May I run the test suite?',
      signal: 'select',
      parameter: { options: [{ name: 'yes', title: 'Run them' }] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ activity: { cardState: 'input-required' } });
    expect((await cardOf(boardId, runId, token)).card.state).toBe('input-required');
  });

  it('documents that the contract helper disagrees with the board, and is unused', () => {
    // `deriveStateFromActivity` is the rule the specs described. It is exported, unit-tested, and
    // called by nothing in apps/api — the board implements a narrower rule inline. Keeping the
    // disagreement visible here means closing it is a deliberate change, not a surprise.
    expect(deriveStateFromActivity('response')).toBe('completed');
    expect(deriveStateFromActivity('error')).toBe('failed');
    // ...while the board leaves the card `working` for both, as the tests above assert.
  });
});
