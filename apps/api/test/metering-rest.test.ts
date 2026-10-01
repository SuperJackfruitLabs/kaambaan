import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const T = { 'X-Tenant-Id': 'tnt_meter', 'Content-Type': 'application/json' };
const base = 'https://api.test';

async function seedWorking(): Promise<{ bid: string; runId: string; leaseEpoch: number }> {
  const board = (await (
    await SELF.fetch(`${base}/v1/boards`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ name: 'M', stages: [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }] }),
    })
  ).json()) as { boardId: string };
  const bid = board.boardId;
  await SELF.fetch(`${base}/v1/boards/${bid}/cards`, { method: 'POST', headers: T, body: JSON.stringify({ title: 'C', ownerUserId: 'usr_a' }) });
  const claim = (await (
    await SELF.fetch(`${base}/v1/boards/${bid}/claims`, { method: 'POST', headers: { ...T, 'X-Agent-Id': 'agt_b' }, body: JSON.stringify({ capabilities: ['build'] }) })
  ).json()) as { runId: string; leaseEpoch: number };
  return { bid, runId: claim.runId, leaseEpoch: claim.leaseEpoch };
}

describe('REST — metering & budgets (docs/07 §6)', () => {
  it('captures usage on an activity and exposes the rollup', async () => {
    const { bid, runId, leaseEpoch } = await seedWorking();
    await SELF.fetch(`${base}/v1/boards/${bid}/runs/${runId}/activities`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ leaseEpoch, type: 'action', usage: { model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 500, costUsd: 0.5 } }),
    });

    const usage = (await (await SELF.fetch(`${base}/v1/boards/${bid}/usage`, { headers: T })).json()) as { totalCostUsd: number; byModel: unknown[] };
    expect(usage.totalCostUsd).toBeCloseTo(0.5, 6);
    expect(usage.byModel).toHaveLength(1);

    const snap = (await (await SELF.fetch(`${base}/v1/boards/${bid}`, { headers: T })).json()) as { usage: { totalCostUsd: number } };
    expect(snap.usage.totalCostUsd).toBeCloseTo(0.5, 6);
  });

  it('sets budget caps via PUT and reflects them in the snapshot', async () => {
    const { bid } = await seedWorking();
    const r = await SELF.fetch(`${base}/v1/boards/${bid}/budget`, { method: 'PUT', headers: T, body: JSON.stringify({ boardUsdCap: 10, cardUsdCap: 2 }) });
    expect(r.status).toBe(200);
    const snap = (await (await SELF.fetch(`${base}/v1/boards/${bid}`, { headers: T })).json()) as { usage: { budgetUsd: number; cardUsdCap: number } };
    expect(snap.usage.budgetUsd).toBe(10);
    expect(snap.usage.cardUsdCap).toBe(2);
  });

  /**
   * The route casts its body (`as { boardUsdCap?; cardUsdCap? }`) and used to forward it to
   * `setBudget` WHOLE. Non-leaking today only because `setBudget`'s input type happens to match
   * the route's declared body type exactly. This asserts a key outside that surface is ignored.
   */
  it('ignores a body key outside the budget surface', async () => {
    const { bid } = await seedWorking();
    const r = await SELF.fetch(`${base}/v1/boards/${bid}/budget`, {
      method: 'PUT',
      headers: T,
      body: JSON.stringify({ boardUsdCap: 5, notABudgetField: 'should never reach the DO' }),
    });
    expect(r.status).toBe(200);
    const snap = (await (await SELF.fetch(`${base}/v1/boards/${bid}`, { headers: T })).json()) as {
      usage: { budgetUsd: number };
    };
    expect(snap.usage.budgetUsd).toBe(5);
  });
});
