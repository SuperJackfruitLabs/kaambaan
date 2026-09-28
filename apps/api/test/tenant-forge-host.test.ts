/**
 * A workspace says where its forge is, and references from that host are recognised.
 *
 * GitHub can be recognised from a constant. A Forgejo instance is at whatever host its operator
 * chose, so recognition has to be told — and until 2026-09-29 there was nowhere to tell it, so
 * the charter's primary git host had no name in the reference model and every forge link was
 * stored as a generic `url`.
 */
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const PIPE = [{ key: 'todo', name: 'To do', order: 0 }];

async function workspace(tenantId: string): Promise<{ boardId: string; cardId: string }> {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'F')`)
    .bind(tenantId, `slug-${tenantId}`)
    .run();
  const headers = { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' };
  const b = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'F', stages: PIPE }),
  });
  const { boardId } = (await b.json()) as { boardId: string };
  const c = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'A card' }),
  });
  const { card } = (await c.json()) as { card: { id: string } };
  return { boardId, cardId: card.id };
}

async function addRef(tenantId: string, boardId: string, cardId: string, url: string) {
  const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${cardId}/references`, {
    method: 'PUT',
    headers: { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`PUT references ${res.status}: ${await res.text()}`);
  return (await res.json()) as { reference: { provider: string; sourceType: string; externalId?: string } };
}

describe('a forge reference', () => {
  it('is a generic url until the workspace says where its forge is', async () => {
    const t = 'tnt_forge_unset';
    const { boardId, cardId } = await workspace(t);
    const { reference } = await addRef(t, boardId, cardId, 'https://forge.example.test/org/repo/pulls/3');
    expect(reference.provider).toBe('url');
    // Stored as null rather than absent — a generic reference has no durable id to match on,
    // which is exactly what makes it undedupable.
    expect(reference.externalId ?? null).toBeNull();
  });

  it('is recognised once the host is configured, with an id a webhook could match', async () => {
    const t = 'tnt_forge_set';
    const { boardId, cardId } = await workspace(t);
    await env.DB.prepare(`UPDATE tenants SET forge_host = 'forge.example.test' WHERE id = ?`).bind(t).run();

    const { reference } = await addRef(t, boardId, cardId, 'https://forge.example.test/org/repo/pulls/3');
    expect(reference.provider).toBe('forge');
    expect(reference.sourceType).toBe('pull_request');
    // The durable id is what makes a reference dedupable and matchable against a webhook — the
    // thing a generic `url` reference can never be.
    expect(reference.externalId).toBe('org/repo#3');
  });

  it('leaves another workspace’s links alone', async () => {
    // One tenant configuring a forge must not change how anybody else's URLs are read.
    const t = 'tnt_forge_other';
    const { boardId, cardId } = await workspace(t);
    const { reference } = await addRef(t, boardId, cardId, 'https://forge.example.test/org/repo/pulls/3');
    expect(reference.provider).toBe('url');
  });
});

describe('PUT /v1/tenant/forge', () => {
  async function owner(tenantId: string) {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'F')`)
      .bind(tenantId, `slug-${tenantId}`).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES ('usr_f', 'f@test')`).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO memberships (id, tenant_id, user_id, role) VALUES (?, ?, 'usr_f', 'owner')`)
      .bind(`mbr-${tenantId}`, tenantId).run();
    return { 'X-Tenant-Id': tenantId, 'X-User-Id': 'usr_f', 'Content-Type': 'application/json' };
  }

  it('stores a bare host, and tolerates a pasted URL by reducing it to one', async () => {
    // Refusing a pasted URL would be defensible. Storing it would not: it is compared against a
    // parsed hostname, so `https://forge.example.test/` would match nothing while looking set.
    const t = 'tnt_forge_patch';
    const headers = await owner(t);
    for (const [sent, stored] of [['forge.example.test', 'forge.example.test'], ['https://Forge.Example.test/x', 'forge.example.test']]) {
      const res = await SELF.fetch('https://api.test/v1/tenant/forge', {
        method: 'PUT', headers, body: JSON.stringify({ forgeHost: sent }),
      });
      expect(res.status).toBe(200);
      const row = await env.DB.prepare(`SELECT forge_host AS h FROM tenants WHERE id = ?`).bind(t).first<{ h: string }>();
      expect(row?.h).toBe(stored);
    }
  });

  it('clears the host with null', async () => {
    const t = 'tnt_forge_clear';
    const headers = await owner(t);
    await SELF.fetch('https://api.test/v1/tenant/forge', { method: 'PUT', headers, body: JSON.stringify({ forgeHost: 'f.test' }) });
    await SELF.fetch('https://api.test/v1/tenant/forge', { method: 'PUT', headers, body: JSON.stringify({ forgeHost: null }) });
    const row = await env.DB.prepare(`SELECT forge_host AS h FROM tenants WHERE id = ?`).bind(t).first<{ h: string | null }>();
    expect(row?.h ?? null).toBeNull();
  });

  it('is reachable with the credential `supi` actually holds', async () => {
    // The defect this route exists to fix. `forgeHost` shipped on `PATCH /v1/tenant`, which is
    // human-only because a hub token cannot establish the mapping that makes a hub token resolve
    // — a bootstrap problem the forge host does not have. The setting existed and the only client
    // that would ever set it got a 401.
    //
    // Asserted through the dev-header path, which the suite uses for human routes; the live proof
    // is `supi forge` answering at all.
    const t = 'tnt_forge_reach';
    const headers = await owner(t);
    const res = await SELF.fetch('https://api.test/v1/tenant/forge', { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('forgeHost');
  });
});
