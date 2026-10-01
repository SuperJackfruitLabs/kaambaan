import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { githubSignatureHeader } from '../src/references/github-signature';

const T = { 'X-Tenant-Id': 'tnt_wh', 'Content-Type': 'application/json' };
const base = 'https://api.test';
const SECRET = 'rest-secret';

async function seed(): Promise<string> {
  const board = (await (
    await SELF.fetch(`${base}/v1/boards`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ name: 'WH', stages: [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }] }),
    })
  ).json()) as { boardId: string };
  const card = (await (
    await SELF.fetch(`${base}/v1/boards/${board.boardId}/cards`, { method: 'POST', headers: T, body: JSON.stringify({ title: 'C', ownerUserId: 'usr_a' }) })
  ).json()) as { card: { id: string } };
  await SELF.fetch(`${base}/v1/boards/${board.boardId}/github`, { method: 'PUT', headers: T, body: JSON.stringify({ secret: SECRET }) });
  await SELF.fetch(`${base}/v1/boards/${board.boardId}/cards/${card.card.id}/references`, {
    method: 'PUT',
    headers: T,
    body: JSON.stringify({ url: 'https://github.com/org/repo/pull/42' }),
  });
  return board.boardId;
}

const payload = () =>
  JSON.stringify({
    action: 'ready_for_review',
    pull_request: { number: 42, draft: false, merged: false, state: 'open', base: { ref: 'main' }, head: { ref: 'feat' }, html_url: 'https://github.com/org/repo/pull/42' },
    repository: { full_name: 'org/repo', default_branch: 'main' },
  });

describe('REST — POST /v1/boards/:id/webhooks/github', () => {
  it('verifies the signature and applies the event (tenant via ?tenant=, GitHub-style)', async () => {
    const boardId = await seed();
    const body = payload();
    const res = await SELF.fetch(`${base}/v1/boards/${boardId}/webhooks/github?tenant=tnt_wh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-GitHub-Delivery': 'gh1',
        'X-Hub-Signature-256': await githubSignatureHeader(SECRET, body),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { matched: number }).matched).toBe(1);

    const snap = (await (await SELF.fetch(`${base}/v1/boards/${boardId}`, { headers: T })).json()) as {
      references: Array<{ externalId: string; metadata: { subState?: string } }>;
    };
    expect(snap.references.find((r) => r.externalId === 'org/repo#42')?.metadata.subState).toBe('awaiting_review');
  });

  it('rejects a bad signature with 401', async () => {
    const boardId = await seed();
    const res = await SELF.fetch(`${base}/v1/boards/${boardId}/webhooks/github?tenant=tnt_wh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-GitHub-Delivery': 'gh2',
        'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`,
      },
      body: payload(),
    });
    expect(res.status).toBe(401);
  });
});

/**
 * `PUT /v1/boards/:id/github` casts its body (`as { secret?; issueTrigger? }`), then builds the
 * call as `{ ...body, triggerGrant: user?.mayDispatch ?? null }` — the body spread BEFORE the
 * trusted value, so `triggerGrant` wins for that field today regardless of what the body sends.
 * That is safe only because the DO input's other fields (`secret`, `issueTrigger`) happen to
 * match the route's declared body type — a coincidence, not a guarantee. This asserts an
 * unexpected body key (a caller-supplied `triggerGrant`) is ignored, not merely that the explicit
 * override already protects that one field.
 */
describe('REST — PUT /v1/boards/:id/github: an unexpected body key does not reach the stored config', () => {
  it('ignores a caller-supplied triggerGrant, recording the route\'s own grant instead', async () => {
    const board = (await (
      await SELF.fetch(`${base}/v1/boards`, {
        method: 'POST',
        headers: T,
        body: JSON.stringify({ name: 'GH', stages: [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }] }),
      })
    ).json()) as { boardId: string };

    const res = await SELF.fetch(`${base}/v1/boards/${board.boardId}/github`, {
      method: 'PUT',
      headers: T,
      body: JSON.stringify({ secret: 'hook', issueTrigger: true, triggerGrant: ['prn_smuggled_in_body'] }),
    });
    expect(res.status).toBe(200);

    // The dev-header principal carries no `mayDispatch` claim, so the route's own grant is null —
    // never the array the body tried to inject.
    const snap = (await (await SELF.fetch(`${base}/v1/boards/${board.boardId}`, { headers: T })).json()) as {
      github: { triggerGrantCount: number | null };
    };
    expect(snap.github.triggerGrantCount).toBeNull();
  });
});
