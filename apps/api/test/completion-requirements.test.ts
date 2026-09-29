/**
 * A stage that says what finishing means, and a board that checks it.
 *
 * `complete()` advanced the card unconditionally, so the Press board reported `published` over a
 * commit sitting unpushed on a station, and later `completed` for a run that had explicitly
 * refused to publish. Both were patched with stage rules — advisory, and the whole argument of
 * this programme is that advisory loses.
 */
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const T = { 'X-Tenant-Id': 'tnt_completion', 'Content-Type': 'application/json' };

/** The Press board's shape in miniature: an agent stage, then somewhere to land. */
function pipeline(completion?: unknown) {
  return [
    { key: 'publish', name: 'Publish', order: 0, ownerKind: 'capability', owner: 'code', ...(completion ? { completion } : {}) },
    { key: 'published', name: 'Published', order: 1, ownerKind: 'human' },
  ];
}

async function board(completion?: unknown, spec?: unknown): Promise<{ boardId: string; runId: string; leaseEpoch: number }> {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'C')`)
    .bind('tnt_completion', 'slug-tnt-completion').run();
  const b = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST', headers: T, body: JSON.stringify({ name: 'C', stages: pipeline(completion) }),
  });
  const { boardId } = (await b.json()) as { boardId: string };
  await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
    method: 'POST', headers: T,
    body: JSON.stringify({ title: 'Ship it', ownerUserId: 'usr_a', ...(spec ? { spec } : {}) }),
  });
  const claim = await (await SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, {
    method: 'POST', headers: { ...T, 'X-Agent-Id': 'agt_coder' }, body: JSON.stringify({ capabilities: ['code'] }),
  })).json() as { runId: string; leaseEpoch: number };
  return { boardId, ...claim };
}

const complete = (boardId: string, runId: string, leaseEpoch: number, handoff: unknown) =>
  SELF.fetch(`https://api.test/v1/boards/${boardId}/runs/${runId}/complete`, {
    method: 'POST', headers: { ...T, 'X-Agent-Id': 'agt_coder' }, body: JSON.stringify({ leaseEpoch, handoff }),
  });

const cardOf = async (boardId: string) =>
  ((await (await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { headers: T })).json()) as {
    cards: Array<{ currentStageKey: string; state: string }>;
  }).cards[0]!;

describe('a stage with no requirement', () => {
  it('advances exactly as it did before, so no existing board changes on deploy', async () => {
    const { boardId, runId, leaseEpoch } = await board();
    expect((await complete(boardId, runId, leaseEpoch, { summary: 'done' })).status).toBe(200);
    expect(await cardOf(boardId)).toMatchObject({ currentStageKey: 'published' });
  });
});

describe('a stage that requires something of the handoff', () => {
  const req = { handoff: ['url', 'commit'] };

  it('advances when the run produced it', async () => {
    const { boardId, runId, leaseEpoch } = await board(req);
    const res = await complete(boardId, runId, leaseEpoch, { url: 'https://x.test/p', commit: 'abc123' });
    expect(res.status).toBe(200);
    expect(await cardOf(boardId)).toMatchObject({ currentStageKey: 'published' });
  });

  it('BLOCKS rather than advancing when it did not — the failure that happened twice', async () => {
    const { boardId, runId, leaseEpoch } = await board(req);
    const res = await complete(boardId, runId, leaseEpoch, { summary: '## Published — all good!' });
    expect(res.status).toBe(200);

    const card = await cardOf(boardId);
    // The card stays where it was. A board that advanced here would be repeating the exact lie
    // this exists to stop: `published`, over work that did not happen.
    expect(card).toMatchObject({ currentStageKey: 'publish', state: 'input-required' });
  });

  it('records the run as blocked, not completed, so the trace does not lie either', async () => {
    const { boardId, runId, leaseEpoch } = await board(req);
    await complete(boardId, runId, leaseEpoch, { summary: 'trust me' });
    const attempts = (await (await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${(await cardOf(boardId) as never as { id: string }).id ?? ''}/attempts`, { headers: T })).json()) as { attempts?: Array<{ outcome: string }> };
    // The receipt reads this. `completed` here is what made a published trace claim a publish run
    // that had refused.
    expect((attempts.attempts ?? []).some((a) => a.outcome === 'blocked')).toBe(true);
  });
});

describe('a card may override its stage', () => {
  it('and the override is honoured', async () => {
    // D3: the operator asked for this. A card that knows its stage's rule does not apply says so.
    const { boardId, runId, leaseEpoch } = await board({ handoff: ['url'] }, { completion: {} });
    expect((await complete(boardId, runId, leaseEpoch, { summary: 'no url here' })).status).toBe(200);
    expect(await cardOf(boardId)).toMatchObject({ currentStageKey: 'published' });
  });
});
