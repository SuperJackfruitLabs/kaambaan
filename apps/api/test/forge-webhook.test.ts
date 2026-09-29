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

/**
 * Two providers, one id space.
 *
 * `externalId` is `owner/repo#n` for GitHub and for forge alike, and the matcher reads it alone.
 * A push mirror mirrors git refs — NOT pull requests — so a forge PR #7 and a GitHub PR #7 on a
 * mirrored repository are DIFFERENT objects that happen to share an id.
 *
 * docs/15 called this a dedupe problem. It is the opposite: nothing needs collapsing, and two
 * unrelated things must stop being treated as one. A forge delivery writing its state onto a
 * GitHub pull request's reference is a wrong enrichment, which is the failure the audit's own
 * reasoning says is harder to notice than a missing one.
 */
describe('a forge delivery and a GitHub reference that share an id', () => {
  it('does not write forge state onto the GitHub pull request', async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'MX')`)
      .bind('tnt_mirror', 'slug-tnt-mirror').run();
    const h = { 'X-Tenant-Id': 'tnt_mirror', 'Content-Type': 'application/json' };

    const b = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST', headers: h,
      body: JSON.stringify({ name: 'MX', stages: [{ key: 'todo', name: 'To do', order: 0 }] }),
    });
    const { boardId } = (await b.json()) as { boardId: string };
    const c = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST', headers: h, body: JSON.stringify({ title: 'Mirrored' }),
    });
    const { card } = (await c.json()) as { card: { id: string } };

    // A reference to the GITHUB pull request #7 of the mirrored repository.
    const ref = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${card.id}/references`, {
      method: 'PUT', headers: h, body: JSON.stringify({ url: 'https://github.com/org/repo/pull/7' }),
    });
    const { reference } = (await ref.json()) as { reference: { id: string; provider: string; externalId: string } };
    expect(reference.provider).toBe('github');
    expect(reference.externalId).toBe('org/repo#7');

    await SELF.fetch(`https://api.test/v1/boards/${boardId}/forge`, {
      method: 'PUT', headers: h, body: JSON.stringify({ secret: SECRET }),
    });

    // A forge delivery for ITS pull request #7 — a different pull request, same id.
    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/webhooks/forge?tenant=tnt_mirror`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forgejo-Signature': await hmacHex(SECRET, payload),
        'X-Forgejo-Delivery': crypto.randomUUID(),
        'X-Forgejo-Event': 'pull_request',
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    // Modelled, and matching nothing: there is no forge reference on this board.
    expect(await res.json()).toMatchObject({ matched: 0, modeled: true });

    const after = await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { headers: h });
    const state = (await after.json()) as { references?: Array<{ id: string; provider: string; metadata?: Record<string, unknown> }> };
    const github = (state.references ?? []).find((r) => r.id === reference.id);
    expect(github?.metadata?.subState, 'a forge event must not set a GitHub reference’s sub-state').toBeUndefined();
  });

  it('and the same holds in the other direction', async () => {
    // Asserted both ways on purpose. A fix applied to one matcher and not the other would pass
    // the test above while leaving the collision live in the direction nobody checked.
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'MY')`)
      .bind('tnt_mirror2', 'slug-tnt-mirror2').run();
    const h = { 'X-Tenant-Id': 'tnt_mirror2', 'Content-Type': 'application/json' };
    await env.DB.prepare(`UPDATE tenants SET forge_host = 'forge.example.test' WHERE id = 'tnt_mirror2'`).run();

    const b = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST', headers: h,
      body: JSON.stringify({ name: 'MY', stages: [{ key: 'todo', name: 'To do', order: 0 }] }),
    });
    const { boardId } = (await b.json()) as { boardId: string };
    const c = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST', headers: h, body: JSON.stringify({ title: 'Mirrored' }),
    });
    const { card } = (await c.json()) as { card: { id: string } };

    // A reference to the FORGE pull request #7.
    const ref = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${card.id}/references`, {
      method: 'PUT', headers: h, body: JSON.stringify({ url: 'https://forge.example.test/org/repo/pulls/7' }),
    });
    const { reference } = (await ref.json()) as { reference: { id: string; provider: string } };
    expect(reference.provider).toBe('forge');

    // A GitHub delivery for ITS pull request #7.
    const ghBody = JSON.stringify({
      action: 'closed',
      repository: { full_name: 'org/repo', default_branch: 'main' },
      pull_request: { number: 7, state: 'closed', merged: true, html_url: 'https://github.com/org/repo/pull/7', base: { ref: 'main' }, head: { ref: 'f' } },
    });
    await SELF.fetch(`https://api.test/v1/boards/${boardId}/github`, {
      method: 'PUT', headers: h, body: JSON.stringify({ secret: SECRET }),
    });
    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/webhooks/github?tenant=tnt_mirror2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': `sha256=${await hmacHex(SECRET, ghBody)}`,
        'X-GitHub-Delivery': crypto.randomUUID(),
        'X-GitHub-Event': 'pull_request',
      },
      body: ghBody,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ matched: 0 });

    const after = await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { headers: h });
    const state = (await after.json()) as { references?: Array<{ id: string; metadata?: Record<string, unknown> }> };
    const forgeRef = (state.references ?? []).find((r) => r.id === reference.id);
    expect(forgeRef?.metadata?.subState, 'a GitHub event must not mark a forge PR merged').toBeUndefined();
  });
});
