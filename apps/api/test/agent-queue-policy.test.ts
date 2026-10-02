import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  countAgentQueuesSince,
  createAgent,
  createAgentToken,
  findAgentByTokenHash,
  recordAgentQueue,
  updateAgent,
} from '../src/db/catalog';
import { hashToken } from '../src/auth/agent-token';

const TENANT = 'tnt_qpol';

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, ?, ?)`)
    .bind(TENANT, 'qpol', 'Queue policy')
    .run();
  await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)`)
    .bind('usr_owner', 'owner@example.test', 'The Operator')
    .run();
});

/**
 * The policy a card-queueing agent is bound by.
 *
 * None of it is the dispatch grant — that stays AgentPod's and arrives in the token. These are the
 * three things this plane has to decide for itself: who ends up answerable for the card, which
 * boards may receive one, and how many per hour.
 */
describe('an agent carries a queueing policy, and its default is to queue nothing', () => {
  it('a freshly connected agent may queue onto no board and owns nothing', async () => {
    // The whole point of the default. An agent that gains `queue` without the operator naming a
    // board must be able to create exactly zero cards — "unset means no board, never every board".
    const agent = await createAgent(env.DB, TENANT, { name: 'Fresh', capabilities: ['research'] });
    const { token } = await createAgentToken(env.DB, TENANT, agent.id, ['read', 'queue']);
    const found = await findAgentByTokenHash(env.DB, await hashToken(token));
    expect(found?.ownerUserId).toBeNull();
    expect(found?.mayQueueTo).toBeNull();
    // A ceiling exists from the start, so no agent is ever unbounded even once a board is named.
    expect(found?.queueCeilingPerHour).toBe(20);
  });

  it('the operator names an owner, the boards, and a ceiling — and the token path reads them', async () => {
    const agent = await createAgent(env.DB, TENANT, { name: 'Chotu', capabilities: ['command'] });
    const { token } = await createAgentToken(env.DB, TENANT, agent.id, ['read', 'queue']);
    await updateAgent(env.DB, TENANT, agent.id, {
      ownerUserId: 'usr_owner',
      mayQueueTo: ['brd_planning', 'brd_devex'],
      queueCeilingPerHour: 6,
    });
    const found = await findAgentByTokenHash(env.DB, await hashToken(token));
    expect(found?.ownerUserId).toBe('usr_owner');
    expect(found?.mayQueueTo).toEqual(['brd_planning', 'brd_devex']);
    expect(found?.queueCeilingPerHour).toBe(6);
  });

  it('an empty allowlist is a DECISION, and the decision is no', async () => {
    // Distinct from null on purpose, the same way an empty `queued_grant` is distinct from a
    // missing one: somebody looked at this agent and said "no boards".
    const agent = await createAgent(env.DB, TENANT, { name: 'Benched', capabilities: ['research'] });
    const { token } = await createAgentToken(env.DB, TENANT, agent.id, ['queue']);
    await updateAgent(env.DB, TENANT, agent.id, { mayQueueTo: [] });
    const found = await findAgentByTokenHash(env.DB, await hashToken(token));
    expect(found?.mayQueueTo).toEqual([]);
  });
});

describe('the ledger counts what an agent has queued', () => {
  it('counts only this agent, and only inside the window', async () => {
    const mine = await createAgent(env.DB, TENANT, { name: 'Counter', capabilities: ['command'] });
    const other = await createAgent(env.DB, TENANT, { name: 'Someone else', capabilities: ['command'] });

    await recordAgentQueue(env.DB, { tenantId: TENANT, agentId: mine.id, boardId: 'brd_a', cardId: 'card_1' });
    await recordAgentQueue(env.DB, { tenantId: TENANT, agentId: mine.id, boardId: 'brd_b', cardId: 'card_2' });
    await recordAgentQueue(env.DB, { tenantId: TENANT, agentId: other.id, boardId: 'brd_a', cardId: 'card_3' });

    // An hour ago — both of mine are inside it, neither of the other agent's counts.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(await countAgentQueuesSince(env.DB, mine.id, hourAgo)).toBe(2);
    expect(await countAgentQueuesSince(env.DB, other.id, hourAgo)).toBe(1);

    // A window that starts in the future contains nothing — the ceiling has to be a MOVING hour,
    // not a counter that fills up once and refuses forever.
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(await countAgentQueuesSince(env.DB, mine.id, later)).toBe(0);
  });

  it('records which board and which card, so an operator can see what was asked for', async () => {
    const agent = await createAgent(env.DB, TENANT, { name: 'Auditable', capabilities: ['command'] });
    await recordAgentQueue(env.DB, { tenantId: TENANT, agentId: agent.id, boardId: 'brd_z', cardId: 'card_z' });
    const row = await env.DB.prepare(
      `SELECT board_id AS boardId, card_id AS cardId FROM agent_card_queues WHERE agent_id = ?`,
    )
      .bind(agent.id)
      .first<{ boardId: string; cardId: string }>();
    expect(row).toEqual({ boardId: 'brd_z', cardId: 'card_z' });
  });
});
