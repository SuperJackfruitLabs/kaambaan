import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { KaambaanAgent, type Fetcher } from '@kaambaan/agent-sdk';
import { setupCatalog } from './helpers/catalog';
import { createAgent, createAgentToken } from '../src/db/catalog';

/**
 * The blocked-agent half of the elicitation return path, through the SDK a harness actually uses.
 *
 * An agent that needs a decision it cannot make itself (a permission prompt, a choice) asks, keeps
 * its lease, and polls the run it holds until the answer appears. Everything here goes through
 * `@kaambaan/agent-sdk` — if the SDK cannot express "ask, then collect the answer", a bridge has to
 * hand-roll the contract, which is how the question came to be posted with no options at all.
 */

beforeAll(setupCatalog);

const STAGES = [{ key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' }];
const baseUrl = 'https://api.test';
const fetcher: Fetcher = (url, init) => SELF.fetch(url, init);

const OPTIONS = [
  { name: 'run_them', title: 'Run the tests' },
  { name: 'skip', title: 'Skip them' },
];

async function createBoard(tenantId: string): Promise<string> {
  const res = await SELF.fetch(`${baseUrl}/v1/boards`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'SDK elicitations', stages: STAGES }),
  });
  return ((await res.json()) as { boardId: string }).boardId;
}

async function addCard(tenantId: string, boardId: string): Promise<void> {
  await SELF.fetch(`${baseUrl}/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Run the suite', ownerUserId: 'usr_a' }),
  });
}

async function connectAgent(tenantId: string) {
  const agent = await createAgent(env.DB, tenantId, { name: 'SDK agent', capabilities: ['research'] });
  const { token } = await createAgentToken(env.DB, tenantId, agent.id, ['claim']);
  return { agentId: agent.id, token };
}

function answerAsHuman(tenantId: string, boardId: string, elicitationId: string, body: unknown) {
  return SELF.fetch(`${baseUrl}/v1/boards/${boardId}/elicitations/${elicitationId}/answer`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId, 'X-User-Id': 'usr_h', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('agent SDK — asking a human, and collecting the answer', () => {
  it('asks with options and reads the answer back off the run it still holds', async () => {
    const tenantId = 'tnt_sdkelc1';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId);
    const { token } = await connectAgent(tenantId);
    const agent = new KaambaanAgent({ baseUrl, boardId, token, fetch: fetcher });

    const work = await agent.claim();
    expect(work).not.toBeNull();

    // The agent hits a permission prompt it cannot answer itself.
    const asked = await agent.ask(work!, 'May I run the test suite?', { options: OPTIONS });
    expect(asked.id).toMatch(/^elc_/);
    expect(asked.status).toBe('pending');
    expect(asked.options).toEqual(OPTIONS); // the options survived the trip — they ride in `parameter`

    // Polling before anyone answers shows the question still open.
    expect((await agent.elicitations(work!))[0]!.status).toBe('pending');

    // A human decides.
    expect((await answerAsHuman(tenantId, boardId, asked.id, { option: 'run_them' })).status).toBe(200);

    // The same poll the agent was already doing now carries the decision.
    const [answered] = await agent.elicitations(work!);
    expect(answered!.status).toBe('answered');
    expect(answered!.answer).toMatchObject({ option: 'run_them', answeredBy: 'usr_h' });
    const ctx = await agent.context(work!);
    expect(ctx.card.state).toBe('working');
    expect(ctx.elicitations[0]!.answer?.option).toBe('run_them');

    // …and the agent finishes the work it was blocked on.
    expect((await agent.complete(work!, { summary: 'tests ran' })).ok).toBe(true);
  });

  it('asks without options when the question is open-ended', async () => {
    const tenantId = 'tnt_sdkelc2';
    const boardId = await createBoard(tenantId);
    await addCard(tenantId, boardId);
    const { token } = await connectAgent(tenantId);
    const agent = new KaambaanAgent({ baseUrl, boardId, token, fetch: fetcher });

    const work = await agent.claim();
    const asked = await agent.ask(work!, 'Which repo should I use?');
    expect(asked.options).toEqual([]);

    await answerAsHuman(tenantId, boardId, asked.id, { text: 'kaambaan' });
    const [answered] = await agent.elicitations(work!);
    expect(answered!.answer).toMatchObject({ option: null, text: 'kaambaan' });
  });
});
