/**
 * POST /v1/boards/:id/cards with a SERVICE-kind hub token — superwitness's nightly canary queueing
 * one card on its own board.
 *
 * Three things must all hold, and none of them alone is enough: the token is a `service`, its scope
 * carries `cards:queue`, and its `sub` is on THIS board's queue-list. The card is then owned by the
 * human who listed the service (`addedBy`), dispatched on the token's `mayDispatch`, and queued by
 * the service principal itself.
 *
 * Every other route keeps refusing a service — tested with a token that DOES succeed on card create,
 * so each refusal is a refusal of the route and not of a broken token.
 */
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { __resetJwksCacheForTests } from '../src/auth/hub-jwt';
import { withIssuer } from './helpers/hub-issuer';

const TENANT = 'tnt_svcq';
const OTHER_TENANT = 'tnt_svcq_other';
const FLEET = 'fleet_0000000000000000sq01';
const OTHER_FLEET = 'fleet_0000000000000000sq02';
const ISSUER = 'https://issuer-svcq.test';
const PLANE = 'https://api.test';
const PIPE = [
  { key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'code' },
  { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
];
/** The live canary's principal (G9). */
const SVC = 'prn_45e839063d7b4a588152';
const OTHER_SVC = 'prn_0123456789abcdef0123';
/** coder-kai's principal, and the agent row it maps to. */
const KAI = 'prn_c0de4a1c0de4a1c0de4a';
const KAI_AGENT = 'agt_svcq_kai';
const STRANGER = 'prn_ffffffffffffffffffff';

const as = (user: string, tenant = TENANT) => ({ 'X-Tenant-Id': tenant, 'X-User-Id': user, 'Content-Type': 'application/json' });
const ADMIN = as('usr_sq_admin');

let signingKey: CryptoKey;
let jwksBody: string;

beforeAll(async () => {
  for (const [t, f] of [[TENANT, FLEET], [OTHER_TENANT, OTHER_FLEET]] as const) {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, 'SQ')`).bind(t, `slug-${t}`).run();
    await env.DB.prepare(`UPDATE tenants SET external_source='agentpod', external_id=? WHERE id=?`).bind(f, t).run();
  }
  for (const [user, tenant] of [['usr_sq_admin', TENANT], ['usr_sq_other_admin', OTHER_TENANT]] as const) {
    await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)`).bind(user, `${user}@test.dev`).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO memberships (id, tenant_id, user_id, role) VALUES (?, ?, ?, 'admin')`)
      .bind(`mbr_${user}`, tenant, user)
      .run();
  }
  await env.DB.prepare(`INSERT OR IGNORE INTO agents (id, tenant_id, name) VALUES (?, ?, 'coder-kai')`).bind(KAI_AGENT, TENANT).run();
  await env.DB.prepare(`UPDATE agents SET external_id = ?, external_source = 'org-plane' WHERE id = ?`).bind(KAI, KAI_AGENT).run();

  const pair = await generateKeyPair('EdDSA', { extractable: true });
  signingKey = pair.privateKey;
  jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'sq-kid' }] });
});
beforeEach(() => __resetJwksCacheForTests());
afterEach(() => {
  delete (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR;
});

/** A token that succeeds on card create once `SVC` is on the board's queue-list. */
const hubToken = (over: Record<string, unknown> = {}) =>
  new SignJWT({
    sub: SVC,
    principalKind: 'service',
    tenant: FLEET,
    mayDispatch: [KAI],
    mayGrantReach: false,
    scope: 'evidence:read cards:queue',
    ...over,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'sq-kid' })
    .setIssuedAt().setIssuer(ISSUER).setAudience([ISSUER, PLANE]).setExpirationTime('5m')
    .sign(signingKey);

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function board(headers = ADMIN): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', { method: 'POST', headers, body: JSON.stringify({ name: 'SQ', stages: PIPE }) });
  expect(res.status).toBe(201);
  return (await res.json<{ boardId: string }>()).boardId;
}

async function list(boardId: string, principalId = SVC, headers = ADMIN): Promise<void> {
  const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/queuers`, { method: 'POST', headers, body: JSON.stringify({ principalId }) });
  expect(res.status).toBe(201);
}

const create = (boardId: string, token: string, body: Record<string, unknown> = { title: 'Nightly canary', spec: { canary: true } }) =>
  SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, { method: 'POST', headers: bearer(token), body: JSON.stringify(body) });

type Card = {
  id: string;
  title: string;
  spec: unknown;
  ownerUserId: string;
  queuedBy: string | null;
  queuedByAgentId: string | null;
  queuedGrant: string[] | null;
  dueAt: string | null;
  currentStageKey: string;
};
type ErrorBody = { error: { code: string; message?: string } };

describe('POST /v1/boards/:id/cards — a queue-listed service holding cards:queue', () => {
  it('creates the card: owned by whoever listed the service, queued by the service, on its grant', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      const res = await create(b, await hubToken());
      expect(res.status).toBe(201);
      const { card } = await res.json<{ card: Card }>();
      expect(card.id).toMatch(/^card_/);
      expect(card).toMatchObject({
        title: 'Nightly canary',
        spec: { canary: true },
        ownerUserId: 'usr_sq_admin',
        queuedBy: SVC,
        queuedByAgentId: null,
        queuedGrant: [KAI],
      });
    });
  });

  it("the board's event trail names the service as who queued the card", async () => {
    const b = await board();
    await list(b);
    const card = await withIssuer(ISSUER, jwksBody, async () => (await (await create(b, await hubToken())).json<{ card: Card }>()).card);
    const { events } = await (await SELF.fetch(`https://api.test/v1/boards/${b}/events`, { headers: ADMIN })).json<{
      events: Array<{ type: string; payload: { card?: Card } }>;
    }>();
    const created = events.find((e) => e.type === 'card.created' && e.payload.card?.id === card.id);
    expect(created?.payload.card).toMatchObject({ queuedBy: SVC, queuedByAgentId: null, ownerUserId: 'usr_sq_admin' });
  });

  it('the card is claimable, under the control pair, by an agent the service may dispatch — and only by one', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      // Two cards: one on a grant naming kai, one on a grant naming nobody kai is.
      expect((await create(b, await hubToken({ mayDispatch: [STRANGER] }), { title: 'not for kai' })).status).toBe(201);
    });
    (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR = 'true';
    const claim = () =>
      SELF.fetch(`https://api.test/v1/boards/${b}/claims`, {
        method: 'POST',
        headers: { 'X-Tenant-Id': TENANT, 'X-Agent-Id': KAI_AGENT, 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilities: ['code'] }),
      }).then((r) => r.json<{ claimed: boolean; card?: { id: string } }>());
    expect((await claim()).claimed).toBe(false);

    const card = await withIssuer(ISSUER, jwksBody, async () => (await (await create(b, await hubToken(), { title: 'for kai' })).json<{ card: Card }>()).card);
    const got = await claim();
    expect(got.claimed).toBe(true);
    expect(got.card?.id).toBe(card.id);
  });

  it('naming the listing admin as owner is allowed; naming anyone else is 403 SERVICE_CANNOT_SET_OWNER', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      const same = await create(b, await hubToken(), { title: 't', ownerUserId: 'usr_sq_admin' });
      expect(same.status).toBe(201);

      const other = await create(b, await hubToken(), { title: 't', ownerUserId: 'usr_someone_else' });
      expect(other.status).toBe(403);
      expect((await other.json<ErrorBody>()).error.code).toBe('SERVICE_CANNOT_SET_OWNER');
    });
  });

  it('validates input exactly like the human path (dueAt)', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      const bad = await create(b, await hubToken(), { title: 't', dueAt: 'tomorrow' });
      expect(bad.status).toBe(400);
      expect((await bad.json<ErrorBody>()).error.code).toBe('INVALID_DUE_AT');

      const good = await create(b, await hubToken(), { title: 't', dueAt: '2026-10-06' });
      expect(good.status).toBe(201);
      expect((await good.json<{ card: Card }>()).card.dueAt).toBe('2026-10-06');
    });
  });

  it('without cards:queue in scope → 403 FORBIDDEN, even on the list', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      for (const scope of ['evidence:read', undefined, 'cards:queued evidence:read']) {
        const res = await create(b, await hubToken({ scope }));
        expect(res.status, String(scope)).toBe(403);
        expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'this principal does not hold cards:queue' } });
      }
    });
  });

  it('a board that does not exist in the service\'s tenant → 404 BOARD_NOT_FOUND', async () => {
    const elsewhere = await board(as('usr_sq_other_admin', OTHER_TENANT));
    await list(elsewhere, SVC, as('usr_sq_other_admin', OTHER_TENANT));
    await withIssuer(ISSUER, jwksBody, async () => {
      for (const b of ['brd_0000000000000000', elsewhere]) {
        const res = await create(b, await hubToken());
        expect(res.status, b).toBe(404);
        expect((await res.json<ErrorBody>()).error.code).toBe('BOARD_NOT_FOUND');
      }
    });
  });

  it("a service not on this board's queue-list → 403 FORBIDDEN", async () => {
    const b = await board();
    await list(b, OTHER_SVC);
    await withIssuer(ISSUER, jwksBody, async () => {
      const res = await create(b, await hubToken());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: "this principal is not on this board's queue-list" } });
    });
  });

  it('removing the service from the list stops it at once', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      expect((await create(b, await hubToken())).status).toBe(201);
    });
    expect((await SELF.fetch(`https://api.test/v1/boards/${b}/queuers/${SVC}`, { method: 'DELETE', headers: ADMIN })).status).toBe(204);
    await withIssuer(ISSUER, jwksBody, async () => {
      expect((await create(b, await hubToken())).status).toBe(403);
    });
  });

  it('an empty mayDispatch → 403 NO_DISPATCH_AUTHORITY (a card nothing could ever claim)', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      const res = await create(b, await hubToken({ mayDispatch: [] }));
      expect(res.status).toBe(403);
      expect((await res.json<ErrorBody>()).error.code).toBe('NO_DISPATCH_AUTHORITY');
    });
  });

  it('a token with no mayDispatch claim at all is not an acceptable service credential (401)', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      const res = await create(b, await hubToken({ mayDispatch: undefined }));
      expect(res.status).toBe(401);
    });
  });

  it('cards:queue on an AGENT-kind token whose sub is listed is not a service, and gets nothing from the list', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      const res = await create(b, await hubToken({ principalKind: 'agent' }));
      expect(res.status).toBe(401);
    });
    const { cards } = await (await SELF.fetch(`https://api.test/v1/boards/${b}`, { headers: ADMIN })).json<{ cards: unknown[] }>();
    expect(cards).toHaveLength(0);
  });
});

describe('a queue-listed cards:queue service is refused everywhere else', () => {
  it('refuses move, PATCH, DELETE, claim, gate resolve, board edits and queuers add — with a token that creates cards', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      const token = await hubToken();
      // Positive control: this exact token is a working credential.
      const made = await create(b, token);
      expect(made.status).toBe(201);
      const { card } = await made.json<{ card: Card }>();

      const signIn = { error: 'sign in to continue' };
      const cases: Array<[string, string, string, unknown, number, unknown]> = [
        ['move', 'POST', `cards/${card.id}/move`, { toStageKey: 'review' }, 401, signIn],
        ['card PATCH', 'PATCH', `cards/${card.id}`, { title: 'renamed' }, 401, signIn],
        ['card DELETE', 'DELETE', `cards/${card.id}`, undefined, 401, signIn],
        ['claim', 'POST', 'claims', { capabilities: ['code'] }, 401, { error: 'a valid agent token is required' }],
        ['gate resolve', 'POST', 'gates/gate_whatever/resolve', { decision: 'approved' }, 401, signIn],
        ['board PATCH', 'PATCH', '', { name: 'renamed' }, 401, signIn],
        ['stages PUT', 'PUT', 'stages', { stages: PIPE }, 401, signIn],
        ['stage PATCH', 'PATCH', 'stages/build', { instructions: 'x' }, 401, signIn],
        ['queuers add', 'POST', 'queuers', { principalId: OTHER_SVC }, 401, signIn],
      ];
      for (const [name, method, rest, body, status, expected] of cases) {
        const res = await SELF.fetch(`https://api.test/v1/boards/${b}${rest ? `/${rest}` : ''}`, {
          method,
          headers: bearer(token),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect(res.status, name).toBe(status);
        expect(await res.json(), name).toEqual(expected);
      }
    });

    // And nothing those calls attempted happened.
    const snap = await (await SELF.fetch(`https://api.test/v1/boards/${b}`, { headers: ADMIN })).json<{ name: string; cards: Card[] }>();
    expect(snap.cards).toHaveLength(1);
    expect(snap.cards[0]).toMatchObject({ title: 'Nightly canary', currentStageKey: 'build' });
    const { queuers } = await (await SELF.fetch(`https://api.test/v1/boards/${b}/queuers`, { headers: ADMIN })).json<{ queuers: Array<{ principalId: string }> }>();
    expect(queuers.map((q) => q.principalId)).toEqual([SVC]);
  });
});

describe('GET /v1/boards/:id/cards/:cardId/attempts — a queuing service reads the cards it queued', () => {
  const attempts = (b: string, cardId: string, headers: Record<string, string>) =>
    SELF.fetch(`https://api.test/v1/boards/${b}/cards/${cardId}/attempts`, { headers });
  const humanCard = async (b: string) => {
    const res = await SELF.fetch(`https://api.test/v1/boards/${b}/cards`, { method: 'POST', headers: ADMIN, body: JSON.stringify({ title: 'by a human' }) });
    expect(res.status).toBe(201);
    return (await res.json<{ card: Card }>()).card;
  };

  it('own card: 200 with exactly the body a human gets', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      const token = await hubToken();
      const { card } = await (await create(b, token)).json<{ card: Card }>();
      const res = await attempts(b, card.id, bearer(token));
      expect(res.status).toBe(200);
      const body = await res.json<{ attempts: unknown[] }>();
      expect(Array.isArray(body.attempts)).toBe(true);
      const human = await attempts(b, card.id, ADMIN);
      expect(body).toEqual(await human.json());
    });
  });

  it('a card queued by a human → 403 FORBIDDEN', async () => {
    const b = await board();
    await list(b);
    const card = await humanCard(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      const res = await attempts(b, card.id, bearer(await hubToken()));
      expect(res.status).toBe(403);
      expect((await res.json<ErrorBody>()).error.code).toBe('FORBIDDEN');
    });
  });

  it('a card queued by a different listed service → 403 FORBIDDEN', async () => {
    const b = await board();
    await list(b);
    await list(b, OTHER_SVC);
    await withIssuer(ISSUER, jwksBody, async () => {
      const { card } = await (await create(b, await hubToken({ sub: OTHER_SVC }))).json<{ card: Card }>();
      const res = await attempts(b, card.id, bearer(await hubToken()));
      expect(res.status).toBe(403);
    });
  });

  it('not on the queue-list (even for its own card, after removal) → 403 FORBIDDEN', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      const token = await hubToken();
      const { card } = await (await create(b, token)).json<{ card: Card }>();
      expect((await attempts(b, card.id, bearer(token))).status).toBe(200);
      await SELF.fetch(`https://api.test/v1/boards/${b}/queuers/${SVC}`, { method: 'DELETE', headers: ADMIN });
      const res = await attempts(b, card.id, bearer(token));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: "this principal is not on this board's queue-list" } });
    });
  });

  it('without cards:queue → 403 FORBIDDEN', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      const { card } = await (await create(b, await hubToken())).json<{ card: Card }>();
      const res = await attempts(b, card.id, bearer(await hubToken({ scope: 'evidence:read' })));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'this principal does not hold cards:queue' } });
    });
  });

  it('unknown card → 404; unknown board → 404 BOARD_NOT_FOUND', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      const token = await hubToken();
      expect((await attempts(b, 'card_nope', bearer(token))).status).toBe(404);
      const res = await attempts('brd_0000000000000000', 'card_nope', bearer(token));
      expect(res.status).toBe(404);
      expect((await res.json<ErrorBody>()).error.code).toBe('BOARD_NOT_FOUND');
    });
  });

  it('no other GET opens: one card, activities, estimate, board snapshot all still refuse the service', async () => {
    const b = await board();
    await list(b);
    await withIssuer(ISSUER, jwksBody, async () => {
      const token = await hubToken();
      const { card } = await (await create(b, token)).json<{ card: Card }>();
      expect((await attempts(b, card.id, bearer(token))).status).toBe(200); // positive control
      for (const rest of [`cards/${card.id}`, `cards/${card.id}/activities`, `cards/${card.id}/estimate`, '']) {
        const res = await SELF.fetch(`https://api.test/v1/boards/${b}${rest ? `/${rest}` : ''}`, { headers: bearer(token) });
        expect(res.status, rest).toBe(401);
        expect(await res.json(), rest).toEqual({ error: 'sign in to continue' });
      }
    });
  });
});
