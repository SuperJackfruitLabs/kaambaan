import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

/**
 * The capability registry (migration 0006).
 *
 * A capability was a free string on both sides of an equality test with nothing defining the set,
 * so five producers each invented a vocabulary: board templates slugified a stage name, the agent
 * editor hardcoded three values, the suite picker defaulted to a token SCOPE, `docs/01` gave a
 * third list, and AgentPod's station capabilities are a different sense of the word entirely.
 *
 * These rows give a capability an identity and a definition. They deliberately do not enumerate
 * what may exist — four of the five reference agent registries decline to define a vocabulary and
 * standardise the record instead.
 */

const T = (tenant: string) => ({ 'X-Tenant-Id': tenant, 'X-User-Id': 'usr_cap', 'Content-Type': 'application/json' });

async function caps(tenant: string) {
  const res = await SELF.fetch('https://api.test/v1/capabilities', { headers: T(tenant) });
  return (await res.json<{ capabilities: Array<Record<string, any>> }>()).capabilities;
}

describe('a capability is a record, not a string on two objects', () => {
  it('registers what a board stage names, because a stage declares a need', async () => {
    const t = 'tnt_cap_stage';
    await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST',
      headers: T(t),
      body: JSON.stringify({
        name: 'B',
        stages: [
          { key: 'review', name: 'Code Review', order: 0, ownerKind: 'capability', owner: 'Code Review' },
          { key: 'done', name: 'Done', order: 1, ownerKind: 'human' },
        ],
      }),
    });

    const list = await caps(t);
    const cr = list.find((c) => c.key === 'code-review')!;
    expect(cr).toBeDefined();
    // Registered from the SNAPSHOT, so it carries the spelling that was actually stored — not the
    // spelling that was asked for.
    expect(cr.origin).toBe('inferred');
    expect(cr.boardCount).toBe(1);
    expect(cr.agentCount).toBe(0); // a lane nobody can work, and the count says so
  });

  it('registers what an agent claims too, rather than refusing it', async () => {
    const t = 'tnt_cap_agent';
    // The first design refused an agent claiming a capability no stage had named. It dead-ended
    // the first agent in a workspace with no boards, and it only ever stopped the NEXT typo.
    const res = await SELF.fetch('https://api.test/v1/agents', {
      method: 'POST',
      headers: T(t),
      body: JSON.stringify({ name: 'A', capabilities: ['triage'] }),
    });
    expect(res.status).toBe(201);

    const cap = (await caps(t)).find((c) => c.key === 'triage')!;
    expect(cap.agentCount).toBe(1);
    expect(cap.boardCount).toBe(0);
  });

  it('counts what the bug looked like: held by agents, named by no stage', async () => {
    const t = 'tnt_cap_orphan';
    // `claim` is a token SCOPE. The picker defaulted to it, so every agent added through it held a
    // capability no stage has ever named, and could claim nothing on any board.
    for (const name of ['One', 'Two', 'Three']) {
      await SELF.fetch('https://api.test/v1/agents', { method: 'POST', headers: T(t), body: JSON.stringify({ name, capabilities: ['claim'] }) });
    }
    const orphan = (await caps(t)).find((c) => c.key === 'claim')!;
    expect(orphan.agentCount).toBe(3);
    expect(orphan.boardCount).toBe(0); // the diagnostic that finds it retroactively
  });

  it('declares one deliberately, with the A2A AgentSkill fields', async () => {
    const t = 'tnt_cap_declare';
    const res = await SELF.fetch('https://api.test/v1/capabilities', {
      method: 'POST',
      headers: T(t),
      body: JSON.stringify({
        key: 'Threat Modelling',
        name: 'Threat modelling',
        description: 'Enumerate attack surface for a change and rank it.',
        tags: ['security'],
        examples: ['Threat model the new webhook endpoint'],
      }),
    });
    expect(res.status).toBe(201);
    const { capability } = await res.json<{ capability: Record<string, any> }>();
    expect(capability.key).toBe('threat-modelling'); // one spelling, same as a stage owner
    expect(capability.origin).toBe('declared');
    expect(capability.tags).toEqual(['security']);
    expect(capability.examples).toHaveLength(1);
  });

  it('refuses a duplicate as a sentence, not a raw constraint failure', async () => {
    const t = 'tnt_cap_dupe';
    const body = JSON.stringify({ key: 'deploy' });
    expect((await SELF.fetch('https://api.test/v1/capabilities', { method: 'POST', headers: T(t), body })).status).toBe(201);
    const again = await SELF.fetch('https://api.test/v1/capabilities', { method: 'POST', headers: T(t), body });
    expect(again.status).toBe(409);
    expect((await again.json<{ error: string }>()).error).toContain('deploy');
  });

  it('refuses a key with nothing in it', async () => {
    const res = await SELF.fetch('https://api.test/v1/capabilities', { method: 'POST', headers: T('tnt_cap_empty'), body: JSON.stringify({ key: '---' }) });
    expect(res.status).toBe(400);
  });

  it('promotes an inferred capability to declared when someone describes it', async () => {
    const t = 'tnt_cap_promote';
    await SELF.fetch('https://api.test/v1/agents', { method: 'POST', headers: T(t), body: JSON.stringify({ name: 'A', capabilities: ['analysis'] }) });
    const before = (await caps(t)).find((c) => c.key === 'analysis')!;
    expect(before.origin).toBe('inferred');

    const res = await SELF.fetch(`https://api.test/v1/capabilities/${before.id}`, {
      method: 'PATCH',
      headers: T(t),
      body: JSON.stringify({ name: 'Analysis', description: 'Read the data and say what it means.' }),
    });
    expect(res.status).toBe(200);

    const after = (await caps(t)).find((c) => c.key === 'analysis')!;
    expect(after.origin).toBe('declared'); // somebody has now looked at it and meant it
    expect(after.description).toContain('what it means');
  });

  it('will not rename a key, because stages and agents carry it', async () => {
    const t = 'tnt_cap_rename';
    await SELF.fetch('https://api.test/v1/capabilities', { method: 'POST', headers: T(t), body: JSON.stringify({ key: 'code' }) });
    const cap = (await caps(t)).find((c) => c.key === 'code')!;
    const res = await SELF.fetch(`https://api.test/v1/capabilities/${cap.id}`, { method: 'PATCH', headers: T(t), body: JSON.stringify({ key: 'coding' }) });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain('cannot be renamed');
  });

  it('refuses to delete one that something still refers to, and names who', async () => {
    const t = 'tnt_cap_inuse';
    await SELF.fetch('https://api.test/v1/agents', { method: 'POST', headers: T(t), body: JSON.stringify({ name: 'Holder', capabilities: ['publish'] }) });
    const cap = (await caps(t)).find((c) => c.key === 'publish')!;

    const refused = await SELF.fetch(`https://api.test/v1/capabilities/${cap.id}`, { method: 'DELETE', headers: T(t) });
    expect(refused.status).toBe(409);
    const body = await refused.json<{ error: string; usage: { agents: string[] } }>();
    expect(body.error).toContain('Holder');
    expect(body.usage.agents).toEqual(['Holder']);
  });

  it('deletes one nothing refers to', async () => {
    const t = 'tnt_cap_free';
    await SELF.fetch('https://api.test/v1/capabilities', { method: 'POST', headers: T(t), body: JSON.stringify({ key: 'unused' }) });
    const cap = (await caps(t)).find((c) => c.key === 'unused')!;
    expect((await SELF.fetch(`https://api.test/v1/capabilities/${cap.id}`, { method: 'DELETE', headers: T(t) })).status).toBe(204);
    expect((await caps(t)).find((c) => c.key === 'unused')).toBeUndefined();
  });

  it('does not show one workspace another workspace\'s vocabulary', async () => {
    await SELF.fetch('https://api.test/v1/capabilities', { method: 'POST', headers: T('tnt_cap_mine'), body: JSON.stringify({ key: 'secret-skill' }) });
    expect((await caps('tnt_cap_theirs')).find((c) => c.key === 'secret-skill')).toBeUndefined();
  });
});

describe('the OASF mapping — a local capability, also known elsewhere', () => {
  it('records the pair, and refuses half of it', async () => {
    const t = 'tnt_cap_oasf';
    await SELF.fetch('https://api.test/v1/capabilities', { method: 'POST', headers: T(t), body: JSON.stringify({ key: 'summarise' }) });
    const cap = (await caps(t)).find((c) => c.key === 'summarise')!;

    // The same borrowing pattern `tenants` and `agents` already use: local ids stay
    // authoritative, and the mapping is how a third plane recognises what we mean.
    const ok = await SELF.fetch(`https://api.test/v1/capabilities/${cap.id}`, {
      method: 'PATCH',
      headers: T(t),
      body: JSON.stringify({ externalId: 'nlp.summarization.abstractive', externalSource: 'oasf' }),
    });
    expect(ok.status).toBe(200);
    const mapped = (await caps(t)).find((c) => c.key === 'summarise')!;
    expect(mapped.externalId).toBe('nlp.summarization.abstractive');
    expect(mapped.externalSource).toBe('oasf');

    // An id with no system to attribute it to cannot be joined against anything, and a wrong join
    // is harder to notice than a missing one — the rule `tenants` and `agents` both enforce.
    const half = await SELF.fetch(`https://api.test/v1/capabilities/${cap.id}`, {
      method: 'PATCH',
      headers: T(t),
      body: JSON.stringify({ externalId: 'cybersecurity.threat_modeling' }),
    });
    expect(half.status).toBe(500); // ExternalMappingError, surfaced as the shared unexpected shape
  });
});
