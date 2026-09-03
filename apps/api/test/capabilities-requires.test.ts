import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

/**
 * The registry must count a stage that names a capability **any way a stage can name one**.
 *
 * This is the coupling that makes set-valued lanes dangerous to add carelessly: `boardCount` was
 * a scalar comparison against `$.owner`. A capability required only by a set-valued lane would
 * have counted zero boards and been reported as an ORPHAN — "held by agents, asked for by no
 * board stage" — by the very diagnostic built to find the original mismatch. Silent, and worse
 * than no diagnostic at all, because it accuses a capability that is working.
 */
const T = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'X-User-Id': 'usr_req', 'Content-Type': 'application/json' });

async function caps(tenant: string) {
  const res = await SELF.fetch('https://api.test/v1/capabilities', { headers: T(tenant) });
  return (await res.json<{ capabilities: Array<Record<string, any>> }>()).capabilities;
}

async function makeBoard(tenant: string, stages: unknown[]): Promise<Response> {
  return SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers: T(tenant),
    body: JSON.stringify({ name: 'B', stages }),
  });
}

describe('a capability named only by a requirement set', () => {
  it('is registered, and counts its board — not reported as an orphan', async () => {
    const t = 'tnt_req_all';
    await makeBoard(t, [
      { key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' },
      { key: 'audit', name: 'Audit', order: 1, ownerKind: 'capability', requires: { all: ['code', 'security'] } },
    ]);

    const list = await caps(t);
    for (const key of ['code', 'security']) {
      const rec = list.find((c) => c.key === key);
      expect(rec, `${key} should be registered from the requirement`).toBeDefined();
      expect(rec!.boardCount, `${key} must count the board that requires it`).toBe(1);
    }
  });

  it('counts both arms — `any` is a way of naming a capability too', async () => {
    const t = 'tnt_req_any';
    await makeBoard(t, [
      { key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' },
      { key: 'impl', name: 'Impl', order: 1, ownerKind: 'capability', requires: { any: ['python', 'typescript'] } },
    ]);

    const list = await caps(t);
    expect(list.find((c) => c.key === 'python')?.boardCount).toBe(1);
    expect(list.find((c) => c.key === 'typescript')?.boardCount).toBe(1);
  });

  it('still counts a plain `owner` lane, and mixes the two shapes in one workspace', async () => {
    const t = 'tnt_req_mixed';
    await makeBoard(t, [
      { key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' },
      { key: 'write', name: 'Write', order: 1, ownerKind: 'capability', owner: 'writing' },
    ]);
    await makeBoard(t, [
      { key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' },
      { key: 'audit', name: 'Audit', order: 1, ownerKind: 'capability', requires: { all: ['writing', 'security'] } },
    ]);

    const list = await caps(t);
    // `writing` is named by both boards, one way each. A legacy row and a new one, counted alike.
    expect(list.find((c) => c.key === 'writing')?.boardCount).toBe(2);
    expect(list.find((c) => c.key === 'security')?.boardCount).toBe(1);
  });

  it('normalises requirement members before storing, so the count matches what routes', async () => {
    const t = 'tnt_req_norm';
    await makeBoard(t, [
      { key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' },
      { key: 'audit', name: 'Audit', order: 1, ownerKind: 'capability', requires: { all: ['Code Review'] } },
    ]);

    const list = await caps(t);
    expect(list.find((c) => c.key === 'code-review')?.boardCount).toBe(1);
    expect(list.find((c) => c.key === 'Code Review')).toBeUndefined();
  });
});
