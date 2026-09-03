import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { expand } from '../src/db/implications';
import { similarKeys } from '../src/db/capabilities';

const T = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'X-User-Id': 'usr_imp', 'Content-Type': 'application/json' });

async function declare(tenant: string, from: string, to: string): Promise<Response> {
  return SELF.fetch('https://api.test/v1/capabilities/implications', {
    method: 'POST',
    headers: T(tenant),
    body: JSON.stringify({ from, to }),
  });
}

describe('expand — declared into effective', () => {
  it('returns the declared set unchanged when nothing is implied', () => {
    expect(expand(['code'], [])).toEqual(['code']);
  });

  it('walks transitively', () => {
    const edges = [
      { from: 'code-review', to: 'code' },
      { from: 'code', to: 'engineering' },
    ];
    expect(expand(['code-review'], edges).sort()).toEqual(['code', 'code-review', 'engineering']);
  });

  it('terminates on a cycle rather than refusing it at write time', () => {
    // `a implies b implies a` says something odd and nothing dangerous — the closure is {a,b}
    // from either end. Refusing it would mean a graph walk on every write to prevent a case that
    // is harmless to survive.
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ];
    expect(expand(['a'], edges).sort()).toEqual(['a', 'b']);
    expect(expand(['b'], edges).sort()).toEqual(['a', 'b']);
  });

  it('handles a diamond without duplicating the shared ancestor', () => {
    const edges = [
      { from: 'x', to: 'l' },
      { from: 'x', to: 'r' },
      { from: 'l', to: 'base' },
      { from: 'r', to: 'base' },
    ];
    const out = expand(['x'], edges);
    expect(out.filter((c) => c === 'base')).toHaveLength(1);
  });

  it('normalises the declared set on the way in', () => {
    expect(expand(['Code Review'], [{ from: 'code-review', to: 'code' }]).sort()).toEqual([
      'code',
      'code-review',
    ]);
  });
});

describe('implication routes', () => {
  it('an implied capability lets an agent claim a lane it never declared', async () => {
    const t = 'tnt_imp_claim';
    // A board whose lane asks for `code`.
    const boardRes = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST',
      headers: T(t),
      body: JSON.stringify({
        name: 'B',
        stages: [
          { key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' },
          { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'code' },
        ],
      }),
    });
    const boardId = (await boardRes.json<{ boardId: string }>()).boardId;

    // An agent staffed only for `code-review`.
    const agentRes = await SELF.fetch('https://api.test/v1/agents', {
      method: 'POST',
      headers: T(t),
      body: JSON.stringify({ name: 'Reviewer', capabilities: ['code-review'] }),
    });
    const agent = await agentRes.json<{ agent: { id: string }; token: string }>();

    const card = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: T(t),
      body: JSON.stringify({ title: 'Work' }),
    });
    const cardId = (await card.json<{ card: { id: string } }>()).card.id;
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${cardId}/move`, {
      method: 'POST',
      headers: T(t),
      body: JSON.stringify({ toStageKey: 'build' }),
    });

    const claimHeaders = { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' };

    // Before the edge exists: refused, because routing is exact equality and it always was.
    const before = await SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, {
      method: 'POST',
      headers: claimHeaders,
      body: JSON.stringify({}),
    });
    expect((await before.json<{ claimed: boolean }>()).claimed).toBe(false);

    // The workspace declares what it already believed: reviewing code is a kind of coding.
    expect((await declare(t, 'code-review', 'code')).status).toBe(201);

    const after = await SELF.fetch(`https://api.test/v1/boards/${boardId}/claims`, {
      method: 'POST',
      headers: claimHeaders,
      body: JSON.stringify({}),
    });
    expect((await after.json<{ claimed: boolean }>()).claimed).toBe(true);
  });

  it('refuses a self-implication with a sentence, not a constraint error', async () => {
    const res = await declare('tnt_imp_self', 'code', 'code');
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain('implies itself');
  });

  it('is idempotent — redeclaring an existing edge is the state the operator asked for', async () => {
    const t = 'tnt_imp_idem';
    expect((await declare(t, 'a', 'b')).status).toBe(201);
    expect((await declare(t, 'a', 'b')).status).toBe(201);
    const list = await SELF.fetch('https://api.test/v1/capabilities/implications', { headers: T(t) });
    expect((await list.json<{ implications: unknown[] }>()).implications).toHaveLength(1);
  });

  it('registers both sides, so an edge cannot name a capability the registry has never heard of', async () => {
    const t = 'tnt_imp_reg';
    await declare(t, 'novel-from', 'novel-to');
    const caps = await SELF.fetch('https://api.test/v1/capabilities', { headers: T(t) });
    const keys = (await caps.json<{ capabilities: Array<{ key: string }> }>()).capabilities.map((c) => c.key);
    expect(keys).toContain('novel-from');
    expect(keys).toContain('novel-to');
  });

  it('surfaces the edges on the capability list, so declared and effective are both visible', async () => {
    const t = 'tnt_imp_list';
    await declare(t, 'code-review', 'code');
    const caps = await SELF.fetch('https://api.test/v1/capabilities', { headers: T(t) });
    const list = (await caps.json<{ capabilities: Array<{ key: string; implies?: string[] }> }>()).capabilities;
    expect(list.find((c) => c.key === 'code-review')?.implies).toEqual(['code']);
    expect(list.find((c) => c.key === 'code')?.implies).toBeUndefined();
  });

  it('deletes an edge, and refuses to delete one that is not there', async () => {
    const t = 'tnt_imp_del';
    await declare(t, 'a', 'b');
    const del = await SELF.fetch('https://api.test/v1/capabilities/implications?from=a&to=b', {
      method: 'DELETE',
      headers: T(t),
    });
    expect(del.status).toBe(204);
    const again = await SELF.fetch('https://api.test/v1/capabilities/implications?from=a&to=b', {
      method: 'DELETE',
      headers: T(t),
    });
    expect(again.status).toBe(404);
  });
});

describe('similarKeys — a hint, never a refusal', () => {
  it('catches a transposition', () => {
    expect(similarKeys('cdoe', ['code', 'writing'])).toEqual(['code']);
  });

  it('catches containment in both directions', () => {
    expect(similarKeys('code', ['code-review'])).toEqual(['code-review']);
    expect(similarKeys('code-review', ['code'])).toEqual(['code']);
  });

  it('never reports the candidate against itself', () => {
    expect(similarKeys('code', ['code'])).toEqual([]);
  });

  it('stays quiet on genuinely different words', () => {
    expect(similarKeys('security', ['writing', 'research'])).toEqual([]);
  });
});
