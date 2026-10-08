import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { createAgent, createAgentToken } from '../src/db/catalog';
import { BoardDO, type BoardInit } from '../src/board/board-do';

/**
 * Card comments: an append-only thread on a card, for people and for the agent working it.
 *
 * Who may post is the point of most of this file. A person posts with board read access — a
 * comment is a remark about the work, not a change to it. An agent posts only while it holds a
 * live run ON THAT CARD, so a token cannot be used to talk on cards it is not working. Nobody edits
 * a comment; its author may delete their own, which leaves a tombstone so the thread still says a
 * comment was there.
 */

beforeAll(setupCatalog);

const base = 'https://api.test';
const STAGES: BoardInit['stages'] = [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }];
const as = (tenant: string, user: string) => ({ 'X-Tenant-Id': tenant, 'X-User-Id': user, 'Content-Type': 'application/json' });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function members(tenant: string, rows: Array<[string, string]>) {
  for (const [user, role] of rows) {
    await env.DB.prepare(`INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (?, ?, ?, ?)`)
      .bind(`mbr_${tenant}_${user}`, tenant, user, role)
      .run();
  }
}

async function board(tenant: string, user = 'usr_owner'): Promise<string> {
  const res = await SELF.fetch(`${base}/v1/boards`, { method: 'POST', headers: as(tenant, user), body: JSON.stringify({ name: 'C', stages: STAGES }) });
  expect(res.status).toBe(201);
  return (await res.json<{ boardId: string }>()).boardId;
}

async function card(tenant: string, boardId: string, title: string, user = 'usr_owner'): Promise<string> {
  const res = await SELF.fetch(`${base}/v1/boards/${boardId}/cards`, { method: 'POST', headers: as(tenant, user), body: JSON.stringify({ title }) });
  expect(res.status).toBe(201);
  return (await res.json<{ card: { id: string } }>()).card.id;
}

const post = (boardId: string, cardId: string, headers: Record<string, string>, body: unknown) =>
  SELF.fetch(`${base}/v1/boards/${boardId}/cards/${cardId}/comments`, { method: 'POST', headers, body: JSON.stringify(body) });
const list = (boardId: string, cardId: string, headers: Record<string, string>) =>
  SELF.fetch(`${base}/v1/boards/${boardId}/cards/${cardId}/comments`, { headers });

async function agentWithToken(tenant: string, name: string) {
  const agent = await createAgent(env.DB, tenant, { name, capabilities: ['build'] });
  const { token } = await createAgentToken(env.DB, tenant, agent.id, ['claim', 'run']);
  return { agentId: agent.id, token };
}

async function claim(boardId: string, token: string) {
  const res = await SELF.fetch(`${base}/v1/boards/${boardId}/claims`, { method: 'POST', headers: bearer(token), body: '{}' });
  expect(res.status).toBe(200);
  const body = await res.json<{ claimed: boolean; runId: string; leaseEpoch: number; card: { id: string } }>();
  expect(body.claimed).toBe(true);
  return body;
}

describe('a person posting and reading', () => {
  it('lets a member post, attributes it to them, and lists it oldest first', async () => {
    const t = 'tnt_cmt_member';
    await members(t, [['usr_owner', 'owner'], ['usr_m', 'member']]);
    const b = await board(t);
    const c = await card(t, b, 'x');

    const one = await post(b, c, as(t, 'usr_m'), { body: 'first' });
    expect(one.status).toBe(201);
    const created = (await one.json<{ comment: Record<string, unknown> }>()).comment;
    expect(created).toMatchObject({ cardId: c, body: 'first', author: { kind: 'human', id: 'usr_m' }, deletedAt: null });
    expect(created.id).toMatch(/^cmt_/);
    await post(b, c, as(t, 'usr_owner'), { body: 'second' });

    const res = await list(b, c, as(t, 'usr_m'));
    expect(res.status).toBe(200);
    const { comments } = await res.json<{ comments: Array<{ body: string }> }>();
    expect(comments.map((x) => x.body)).toEqual(['first', 'second']);
  });

  it('lets a viewer read and post — commenting needs board read access, not the right to change the card', async () => {
    const t = 'tnt_cmt_viewer';
    await members(t, [['usr_owner', 'owner'], ['usr_v', 'viewer']]);
    const b = await board(t);
    const c = await card(t, b, 'x');
    expect((await post(b, c, as(t, 'usr_v'), { body: 'a question' })).status).toBe(201);
    expect((await list(b, c, as(t, 'usr_v'))).status).toBe(200);
  });

  it('refuses a signed-in person who is not a member of the workspace, on read and on post', async () => {
    const t = 'tnt_cmt_outsider';
    await members(t, [['usr_owner', 'owner']]);
    const b = await board(t);
    const c = await card(t, b, 'x');
    expect((await post(b, c, as(t, 'usr_stranger'), { body: 'hi' })).status).toBe(403);
    expect((await list(b, c, as(t, 'usr_stranger'))).status).toBe(403);
  });

  it('refuses an empty body, a body over 8 KB, and a comment on a card that does not exist', async () => {
    const t = 'tnt_cmt_shape';
    const b = await board(t);
    const c = await card(t, b, 'x');
    expect((await post(b, c, as(t, 'usr_owner'), { body: '   ' })).status).toBe(400);
    expect((await post(b, c, as(t, 'usr_owner'), { body: 7 })).status).toBe(400);
    expect((await post(b, c, as(t, 'usr_owner'), { body: 'é'.repeat(4097) })).status).toBe(400); // 8194 bytes
    expect((await post(b, c, as(t, 'usr_owner'), { body: 'a'.repeat(8192) })).status).toBe(201);
    expect((await post(b, 'card_nope', as(t, 'usr_owner'), { body: 'hi' })).status).toBe(404);
  });

  it('stores markup as text: what was sent is what is read back, never interpreted', async () => {
    const t = 'tnt_cmt_markup';
    const b = await board(t);
    const c = await card(t, b, 'x');
    const evil = '<img src=x onerror="alert(1)"> **bold** <script>alert(2)</script>';
    await post(b, c, as(t, 'usr_owner'), { body: evil });
    const { comments } = await (await list(b, c, as(t, 'usr_owner'))).json<{ comments: Array<{ body: string }> }>();
    expect(comments[0]!.body).toBe(evil);
  });
});

describe('deleting', () => {
  it('lets the author delete their own comment, leaving a tombstone with no body', async () => {
    const t = 'tnt_cmt_del';
    await members(t, [['usr_owner', 'owner'], ['usr_m', 'member']]);
    const b = await board(t);
    const c = await card(t, b, 'x');
    const { comment } = await (await post(b, c, as(t, 'usr_m'), { body: 'oops, a secret' })).json<{ comment: { id: string } }>();

    // Not the author — not even the workspace owner — may delete it.
    const other = await SELF.fetch(`${base}/v1/boards/${b}/cards/${c}/comments/${comment.id}`, { method: 'DELETE', headers: as(t, 'usr_owner') });
    expect(other.status).toBe(403);

    const mine = await SELF.fetch(`${base}/v1/boards/${b}/cards/${c}/comments/${comment.id}`, { method: 'DELETE', headers: as(t, 'usr_m') });
    expect(mine.status).toBe(200);

    const { comments } = await (await list(b, c, as(t, 'usr_m'))).json<{ comments: Array<{ id: string; body: string; deletedAt: string | null }> }>();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ id: comment.id, body: '' });
    expect(comments[0]!.deletedAt).not.toBeNull();

    // The board's event log records that it happened, never what it said.
    const { events } = await (await SELF.fetch(`${base}/v1/boards/${b}/events?limit=500`, { headers: as(t, 'usr_m') })).json<{ events: unknown[] }>();
    expect(JSON.stringify(events)).not.toContain('oops, a secret');
  });

  it('refuses any edit: there is no PATCH', async () => {
    const t = 'tnt_cmt_noedit';
    const b = await board(t);
    const c = await card(t, b, 'x');
    const { comment } = await (await post(b, c, as(t, 'usr_owner'), { body: 'v1' })).json<{ comment: { id: string } }>();
    const res = await SELF.fetch(`${base}/v1/boards/${b}/cards/${c}/comments/${comment.id}`, {
      method: 'PATCH',
      headers: as(t, 'usr_owner'),
      body: JSON.stringify({ body: 'v2' }),
    });
    expect(res.status).toBe(405);
  });
});

describe('an agent posting', () => {
  it('may post on the card its live run holds, attributed to the agent by name', async () => {
    const t = 'tnt_cmt_agent_ok';
    const b = await board(t);
    const c = await card(t, b, 'x');
    const { agentId, token } = await agentWithToken(t, 'Builder');
    await claim(b, token);

    const res = await post(b, c, bearer(token), { body: 'Found the cause; fixing.' });
    expect(res.status).toBe(201);
    expect((await res.json<{ comment: unknown }>()).comment).toMatchObject({ author: { kind: 'agent', id: agentId, name: 'Builder' } });
  });

  it('is refused on a card its run does not hold', async () => {
    const t = 'tnt_cmt_agent_other';
    const b = await board(t);
    const mine = await card(t, b, 'mine');
    const { token } = await agentWithToken(t, 'Builder');
    const claimed = await claim(b, token);
    expect(claimed.card.id).toBe(mine);
    const other = await card(t, b, 'not mine');

    expect((await post(b, other, bearer(token), { body: 'hi' })).status).toBe(403);
  });

  it('is refused once its run has ended', async () => {
    const t = 'tnt_cmt_agent_ended';
    const b = await board(t);
    const c = await card(t, b, 'x');
    const { token } = await agentWithToken(t, 'Builder');
    const { runId, leaseEpoch } = await claim(b, token);
    const done = await SELF.fetch(`${base}/v1/boards/${b}/runs/${runId}/release`, { method: 'POST', headers: bearer(token), body: JSON.stringify({ leaseEpoch }) });
    expect(done.status).toBe(200);
    expect((await post(b, c, bearer(token), { body: 'late' })).status).toBe(403);
  });

  it('is refused on a token without the run scope, and may read on read', async () => {
    const t = 'tnt_cmt_agent_scope';
    const b = await board(t);
    const c = await card(t, b, 'x');
    const agent = await createAgent(env.DB, t, { name: 'Reader', capabilities: ['build'] });
    const { token } = await createAgentToken(env.DB, t, agent.id, ['read']);
    expect((await post(b, c, bearer(token), { body: 'hi' })).status).toBe(403);
    expect((await list(b, c, bearer(token))).status).toBe(200);
  });

  it('may not delete, even its own', async () => {
    const t = 'tnt_cmt_agent_del';
    const b = await board(t);
    const c = await card(t, b, 'x');
    const { token } = await agentWithToken(t, 'Builder');
    await claim(b, token);
    const { comment } = await (await post(b, c, bearer(token), { body: 'note' })).json<{ comment: { id: string } }>();
    const res = await SELF.fetch(`${base}/v1/boards/${b}/cards/${c}/comments/${comment.id}`, { method: 'DELETE', headers: bearer(token) });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThanOrEqual(403);
  });
});

describe('the agent sees the thread', () => {
  it('in GET /runs/:runId — newest comments, oldest first, without tombstones', async () => {
    const t = 'tnt_cmt_ctx';
    const b = await board(t);
    const c = await card(t, b, 'x');
    await post(b, c, as(t, 'usr_owner'), { body: 'please also cover the expired-token path' });
    const { comment: gone } = await (await post(b, c, as(t, 'usr_owner'), { body: 'deleted' })).json<{ comment: { id: string } }>();
    await SELF.fetch(`${base}/v1/boards/${b}/cards/${c}/comments/${gone.id}`, { method: 'DELETE', headers: as(t, 'usr_owner') });
    const { token } = await agentWithToken(t, 'Builder');
    const { runId } = await claim(b, token);

    const ctx = await (await SELF.fetch(`${base}/v1/boards/${b}/runs/${runId}`, { headers: bearer(token) })).json<{
      comments: Array<{ body: string; author: { kind: string } }>;
      commentsOmitted: number;
    }>();
    expect(ctx.comments.map((x) => x.body)).toEqual(['please also cover the expired-token path']);
    expect(ctx.comments[0]!.author.kind).toBe('human');
    expect(ctx.commentsOmitted).toBe(0);
  });
});

describe('BoardDO — the run context bounds the thread', () => {
  it('carries at most the newest 20, under 16 KB of body, and says how many it left out', async () => {
    await runInDurableObject(env.BOARD_DO.get(env.BOARD_DO.idFromName('cmt-bound')) as unknown as DurableObjectStub<BoardDO>, async (doBoard: BoardDO) => {
      await doBoard.init({ id: 'brd_cmt_b', tenantId: 'tnt_a', name: 'B', stages: STAGES });
      const made = await doBoard.createCard({ title: 'x', ownerUserId: 'usr_a' });
      if (!made.ok) throw new Error('card');
      for (let i = 0; i < 25; i++) {
        const r = await doBoard.addComment({ cardId: made.value.id, author: { kind: 'human', id: 'usr_a', name: null }, body: `c${i}` });
        expect(r.ok).toBe(true);
      }
      const claimed = await doBoard.claim({ agentId: 'agt_a', capabilities: ['build'] });
      if (!claimed.claimed) throw new Error('claim');
      const ctx = await doBoard.getRunContext({ runId: claimed.runId, agentId: 'agt_a' });
      if (!ctx.ok) throw new Error('ctx');
      expect(ctx.value.comments.map((c) => c.body)).toEqual(Array.from({ length: 20 }, (_, i) => `c${i + 5}`));
      expect(ctx.value.commentsOmitted).toBe(5);

      // Big comments: the byte budget, not the count, is what stops it.
      for (let i = 0; i < 3; i++) {
        await doBoard.addComment({ cardId: made.value.id, author: { kind: 'human', id: 'usr_a', name: null }, body: 'z'.repeat(8000) + i });
      }
      const big = await doBoard.getRunContext({ runId: claimed.runId, agentId: 'agt_a' });
      if (!big.ok) throw new Error('ctx');
      expect(big.value.comments.map((c) => c.body.slice(-1))).toEqual(['1', '2']);
      expect(big.value.commentsOmitted).toBe(26);
    });
  });
});
