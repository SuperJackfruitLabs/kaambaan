/**
 * The forge webhook door, end to end.
 *
 * Parallel to the GitHub one and deliberately not shared with it: the dedupe table and the
 * reference update are identical, while the signature spelling and the event vocabulary are not
 * — and those are exactly the parts that fail silently when assumed.
 */
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const TENANT = 'tnt_forge_hook';
const headers = { 'X-Tenant-Id': TENANT, 'Content-Type': 'application/json' };
const SECRET = 'a-forge-secret';

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function boardWithForgeRef(): Promise<{ boardId: string; cardId: string }> {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'FH')`).bind(TENANT, `slug-${TENANT}`).run();
  await env.DB.prepare(`UPDATE tenants SET forge_host = 'forge.example.test' WHERE id = ?`).bind(TENANT).run();
  const b = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'FH', stages: [{ key: 'todo', name: 'To do', order: 0 }] }),
  });
  const { boardId } = (await b.json()) as { boardId: string };
  const c = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
    method: 'POST', headers, body: JSON.stringify({ title: 'Ship it' }),
  });
  const { card } = (await c.json()) as { card: { id: string } };
  await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${card.id}/references`, {
    method: 'PUT', headers,
    body: JSON.stringify({ url: 'https://forge.example.test/org/repo/pulls/7' }),
  });
  await SELF.fetch(`https://api.test/v1/boards/${boardId}/forge`, {
    method: 'PUT', headers, body: JSON.stringify({ secret: SECRET }),
  });
  return { boardId, cardId: card.id };
}

const payload = JSON.stringify({
  action: 'synchronized',
  repository: { full_name: 'org/repo', default_branch: 'main' },
  pull_request: { number: 7, state: 'open', html_url: 'https://forge.example.test/org/repo/pulls/7', base: { ref: 'main' }, head: { ref: 'f' } },
});

async function deliver(boardId: string, opts: { signature?: string | null; delivery?: string | null; event?: string } = {}) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const sig = opts.signature === undefined ? await hmacHex(SECRET, payload) : opts.signature;
  if (sig) h['X-Forgejo-Signature'] = sig;
  if (opts.delivery !== null) h['X-Forgejo-Delivery'] = opts.delivery ?? crypto.randomUUID();
  h['X-Forgejo-Event'] = opts.event ?? 'pull_request';
  return SELF.fetch(`https://api.test/v1/boards/${boardId}/webhooks/forge?tenant=${TENANT}`, { method: 'POST', headers: h, body: payload });
}

describe('POST /v1/boards/:id/webhooks/forge', () => {
  it('accepts a bare-hex signature and updates the referenced pull request', async () => {
    const { boardId } = await boardWithForgeRef();
    const res = await deliver(boardId);
    expect(res.status).toBe(200);
    // `synchronized` is Forgejo's spelling; the GitHub mapper would have returned null here and
    // the delivery would have been accepted while changing nothing.
    expect(await res.json()).toMatchObject({ matched: 1, modeled: true });
  });

  it('refuses a GitHub-style prefixed signature, which is a different claim', async () => {
    const { boardId } = await boardWithForgeRef();
    const res = await deliver(boardId, { signature: `sha256=${await hmacHex(SECRET, payload)}` });
    expect(res.status).toBe(401);
  });

  it('refuses a wrong signature and a missing one', async () => {
    const { boardId } = await boardWithForgeRef();
    expect((await deliver(boardId, { signature: 'f'.repeat(64) })).status).toBe(401);
    expect((await deliver(boardId, { signature: null })).status).toBe(401);
  });

  it('fails closed when the delivery id is missing, rather than skipping replay protection', async () => {
    const { boardId } = await boardWithForgeRef();
    const res = await deliver(boardId, { delivery: null });
    expect(res.status).toBe(400);
  });

  it('dedupes a redelivery', async () => {
    const { boardId } = await boardWithForgeRef();
    const id = crypto.randomUUID();
    expect(await (await deliver(boardId, { delivery: id })).json()).toMatchObject({ deduped: false });
    expect(await (await deliver(boardId, { delivery: id })).json()).toMatchObject({ deduped: true });
  });

  it('refuses everything until a secret is configured', async () => {
    const b = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'NoSecret', stages: [{ key: 'todo', name: 'To do', order: 0 }] }),
    });
    const { boardId } = (await b.json()) as { boardId: string };
    const res = await deliver(boardId);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
