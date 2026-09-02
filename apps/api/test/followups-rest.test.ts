import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const T = { 'X-Tenant-Id': 'tnt_fu', 'Content-Type': 'application/json' };
const base = 'https://api.test';

async function seed(): Promise<{ bid: string; cardId: string }> {
  const board = (await (
    await SELF.fetch(`${base}/v1/boards`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ name: 'FU', stages: [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }] }),
    })
  ).json()) as { boardId: string };
  const card = (await (
    await SELF.fetch(`${base}/v1/boards/${board.boardId}/cards`, { method: 'POST', headers: T, body: JSON.stringify({ title: 'C', ownerUserId: 'usr_owner' }) })
  ).json()) as { card: { id: string } };
  return { bid: board.boardId, cardId: card.card.id };
}

describe('REST — attempts, estimate, notifications (docs/07 §5-7)', () => {
  it('exposes attempts, an estimate, and the notification feed', async () => {
    const { bid, cardId } = await seed();
    const claim = (await (
      await SELF.fetch(`${base}/v1/boards/${bid}/claims`, { method: 'POST', headers: { ...T, 'X-Agent-Id': 'agt_b' }, body: JSON.stringify({ capabilities: ['build'] }) })
    ).json()) as { runId: string; leaseEpoch: number };
    await SELF.fetch(`${base}/v1/boards/${bid}/runs/${claim.runId}/activities`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ leaseEpoch: claim.leaseEpoch, type: 'action', usage: { model: 'claude-opus-4-8', costUsd: 0.6 } }),
    });
    await SELF.fetch(`${base}/v1/boards/${bid}/runs/${claim.runId}/fail`, { method: 'POST', headers: T, body: JSON.stringify({ leaseEpoch: claim.leaseEpoch, reason: 'boom' }) });

    // Attempts
    const attempts = ((await (await SELF.fetch(`${base}/v1/boards/${bid}/cards/${cardId}/attempts`, { headers: T })).json()) as { attempts: any[] }).attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ agentId: 'agt_b', model: 'claude-opus-4-8' });
    expect(attempts[0].costUsd).toBeCloseTo(0.6, 6);

    // Estimate (one ended run at 'build' cost $0.60)
    const est = (await (await SELF.fetch(`${base}/v1/boards/${bid}/cards/${cardId}/estimate`, { headers: T })).json()) as { estimatedUsd: number; sampleSize: number };
    expect(est.sampleSize).toBe(1);
    expect(est.estimatedUsd).toBeCloseTo(0.6, 6);

    // Notifications: the failure raised one; unread filter + mark read.
    //
    // Read AS the card's owner. `notifications.user_id` is written from the card owner and is now
    // used as a filter — it was written and never read, so every board notification reached every
    // caller, which one member per workspace made invisible and a second member makes a
    // disclosure.
    const asOwner = { ...T, 'X-User-Id': 'usr_owner' };
    const feed = ((await (await SELF.fetch(`${base}/v1/boards/${bid}/notifications?unread=true`, { headers: asOwner })).json()) as { notifications: any[] }).notifications;
    expect(feed.some((n) => n.kind === 'failed')).toBe(true);

    // And someone else's feed does not carry it.
    const stranger = ((await (
      await SELF.fetch(`${base}/v1/boards/${bid}/notifications?unread=true`, { headers: { ...T, 'X-User-Id': 'usr_other' } })
    ).json()) as { notifications: any[] }).notifications;
    expect(stranger.some((n) => n.kind === 'failed')).toBe(false);
    const seq = feed[0].seq;
    const read = await SELF.fetch(`${base}/v1/boards/${bid}/notifications/${seq}/read`, { method: 'POST', headers: asOwner });
    expect(read.status).toBe(200);
    const after = ((await (await SELF.fetch(`${base}/v1/boards/${bid}/notifications?unread=true`, { headers: T })).json()) as { notifications: any[] }).notifications;
    expect(after.find((n) => n.seq === seq)).toBeUndefined();
  });

  it('supports a windowed usage query over REST', async () => {
    const { bid } = await seed();
    const res = await SELF.fetch(`${base}/v1/boards/${bid}/usage?window=5h`, { headers: T });
    expect(res.status).toBe(200);
    expect((await res.json()) as { totalCostUsd: number }).toHaveProperty('totalCostUsd');
  });
});
