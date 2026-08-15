import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

/**
 * Who queued a card — the principal on whose behalf an agent runs it.
 *
 * The control pair asks "who may dispatch which agent"
 * (`charter` → `decisions/2026-08-13-ecosystem-identity.md`, Decision 4). To
 * answer that here, at claim time, the board has to know who caused the card to
 * become claimable. AgentPod's half shipped first (agentpod#337); this is the
 * record kaambaan's half will read.
 *
 * The subtlety these cover: a card reaches the claimable state from six places
 * and only two are a human act — creating it and moving it. A stage advancing
 * after a run completes, a release, a reclaim and a gate resolving are all
 * automatic, and none of them may overwrite the queuer, or the pipeline that
 * follows would look self-dispatched.
 */

const PIPELINE = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'capability', owner: 'research' },
  { key: 'done', name: 'Done', order: 2, ownerKind: 'human' },
];

const dev = (tenant: string, user?: string) => ({
  'X-Tenant-Id': tenant,
  ...(user ? { 'X-User-Id': user } : {}),
  'Content-Type': 'application/json',
});

async function board(tenant: string, user: string): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers: dev(tenant, user),
    body: JSON.stringify({ name: 'Q', stages: PIPELINE }),
  });
  return (await res.json<{ boardId: string }>()).boardId;
}

async function snapshot(tenant: string, boardId: string) {
  const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { headers: dev(tenant) });
  return res.json<{ cards: Array<Record<string, unknown>> }>();
}

describe('the card records who queued it', () => {
  it('records the creator when a card is created', async () => {
    const t = 'tnt_q1';
    const boardId = await board(t, 'usr_creator');

    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(t, 'usr_creator'),
      body: JSON.stringify({ title: 'A card' }),
    });

    const { cards } = await snapshot(t, boardId);
    expect(cards).toHaveLength(1);
    // Creating a card in the first stage IS queueing it — it is claimable the
    // moment it exists.
    expect(cards[0]!.queuedBy ?? cards[0]!.ownerUserId).toBe('usr_creator');
  });

  it('records the mover, who need not be the creator', async () => {
    // The reason this is not just `owner_user_id`: whoever moves a card into a
    // dispatchable stage is the one dispatching it now.
    const t = 'tnt_q2';
    const boardId = await board(t, 'usr_creator');

    const created = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(t, 'usr_creator'),
      body: JSON.stringify({ title: 'Moved by someone else' }),
    });
    const cardId = (await created.json<{ card: { id: string } }>()).card.id;

    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${cardId}/move`, {
      method: 'POST',
      headers: dev(t, 'usr_mover'),
      body: JSON.stringify({ toStageKey: 'review' }),
    });

    const { cards } = await snapshot(t, boardId);
    const card = cards.find((c) => c.id === cardId)!;
    expect(card.queuedBy).toBe('usr_mover');
  });

  it('keeps the queuer when the card advances on its own', async () => {
    // The case that decides the whole model. An agent finishing a stage
    // advances the card automatically; if that blanked or reassigned the
    // queuer, every pipeline step after the first would look self-dispatched and
    // the control pair would have nobody to check.
    const t = 'tnt_q3';
    const boardId = await board(t, 'usr_creator');

    const created = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(t, 'usr_creator'),
      body: JSON.stringify({ title: 'Runs through a pipeline' }),
    });
    const cardId = (await created.json<{ card: { id: string } }>()).card.id;

    const claimed = await SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, {
      method: 'POST',
      headers: { ...dev(t), 'X-Agent-Id': 'agt_worker' },
      body: JSON.stringify({ capabilities: ['research'] }),
    });
    const claim = await claimed.json<{ claimed: boolean; runId?: string; leaseEpoch?: number }>();
    expect(claim.claimed).toBe(true);

    const done = await SELF.fetch(`https://api.test/v1/boards/${boardId}/runs/${claim.runId}/complete`, {
      method: 'POST',
      headers: { ...dev(t), 'X-Agent-Id': 'agt_worker' },
      // The lease epoch is the fencing token; without it the board refuses the
      // completion and the card never advances — which is what made the first
      // version of this test look like a queuer bug.
      body: JSON.stringify({ leaseEpoch: claim.leaseEpoch, handoff: { summary: 'done' } }),
    });
    expect(done.status).toBe(200);

    const { cards } = await snapshot(t, boardId);
    const card = cards.find((c) => c.id === cardId)!;
    expect(card.currentStageKey).toBe('review');
    // Still the person who queued it, not the agent that advanced it.
    expect(card.queuedBy).toBe('usr_creator');
  });
});
