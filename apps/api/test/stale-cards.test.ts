import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { BoardDO, type BoardInit } from '../src/board/board-do';

/**
 * Stale cards: work that is waiting and will go on waiting.
 *
 * Two shapes. A card in `input-required` is waiting on a person, and says why (`needsHuman`). A card
 * sitting `submitted` in a stage no agent can claim and no gate will ever ask about — an intake
 * column such as `requested` — is waiting on nobody at all, and nothing anywhere says so. Both are
 * listed once they have sat past the board's threshold, and a daily digest tells the card's owner.
 */

beforeAll(setupCatalog);

const STAGES: BoardInit['stages'] = [
  { key: 'requested', name: 'Requested', order: 0, ownerKind: 'human' },
  { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'build' },
  { key: 'review', name: 'Review', order: 2, ownerKind: 'human', gate: 'approval' },
  { key: 'done', name: 'Done', order: 3, ownerKind: 'human' },
];
const BUILDER = { agentId: 'agt_b', capabilities: ['build'] };
const HOUR = 3600_000;
const later = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

/** A board with: one card sitting in `requested`, one blocked at `build`, one claimable at `build`. */
async function seeded(b: BoardDO, id: string) {
  await b.init({ id, tenantId: 'tnt_stale', name: 'Stale board', stages: STAGES });
  const intake = await b.createCard({ title: 'Nobody picks me up', ownerUserId: 'usr_owner' });
  const blocked = await b.createCard({ title: 'Blocked <img src=x onerror=alert(1)>', ownerUserId: 'usr_owner' });
  const fine = await b.createCard({ title: 'Healthy', ownerUserId: 'usr_owner' });
  if (!intake.ok || !blocked.ok || !fine.ok) throw new Error('create failed');
  await b.moveCard(blocked.value.id, 'build');
  const c = await b.claim(BUILDER);
  if (!c.claimed) throw new Error('expected claim');
  await b.block({ runId: c.runId, leaseEpoch: c.leaseEpoch, reason: 'the staging database is down' });
  await b.moveCard(fine.value.id, 'build');
  return { intake: intake.value.id, blocked: blocked.value.id, fine: fine.value.id };
}

describe('detecting stale cards', () => {
  it('lists nothing before the threshold, and both shapes after it — never a claimable card', async () => {
    await runInDurableObject(stubFor('stale-detect'), async (b: BoardDO) => {
      const ids = await seeded(b, 'brd_st1');
      expect(await b.staleCards({ nowIso: later(23) })).toEqual([]);

      const stale = await b.staleCards({ nowIso: later(25) });
      expect(stale.map((s) => s.cardId).sort()).toEqual([ids.intake, ids.blocked].sort());

      const blocked = stale.find((s) => s.cardId === ids.blocked)!;
      expect(blocked).toMatchObject({
        boardId: 'brd_st1', boardName: 'Stale board', stageKey: 'build', state: 'input-required',
        why: { kind: 'needs-human', reason: 'blocked', detail: 'the staging database is down' },
      });
      expect(blocked.ageHours).toBeGreaterThanOrEqual(25);
      expect(blocked.next).toContain(`supi resume brd_st1 ${ids.blocked}`);

      const intake = stale.find((s) => s.cardId === ids.intake)!;
      expect(intake).toMatchObject({ stageKey: 'requested', state: 'submitted', why: { kind: 'no-owner' } });
      expect(intake.next).toContain('requested');
    });
  });

  it('honours the per-board threshold, an explicit override, and the off switch', async () => {
    await runInDurableObject(stubFor('stale-settings'), async (b: BoardDO) => {
      await seeded(b, 'brd_st2');
      expect((await b.setStaleSettings({ afterHours: 2 })).ok).toBe(true);
      expect((await b.getState()).stale).toEqual({ enabled: true, afterHours: 2 });
      expect((await b.staleCards({ nowIso: later(3) })).length).toBe(2);
      expect((await b.staleCards({ nowIso: later(1) })).length).toBe(0);
      // An explicit threshold wins over the board's.
      expect((await b.staleCards({ nowIso: later(1), afterHours: 0 })).length).toBe(2);

      await b.setStaleSettings({ enabled: false });
      expect((await b.staleCards({ nowIso: later(48) })).length).toBe(0);
      // Asking explicitly still answers: the switch silences the board, it does not hide its cards.
      expect((await b.staleCards({ nowIso: later(48), afterHours: 24 })).length).toBe(2);

      expect((await b.setStaleSettings({ afterHours: -1 })).ok).toBe(false);
      expect((await b.setStaleSettings({ afterHours: Number.NaN })).ok).toBe(false);
    });
  });

  it('measures age from when the card stopped, not from when it was created', async () => {
    await runInDurableObject(stubFor('stale-age'), async (b: BoardDO, state) => {
      const ids = await seeded(b, 'brd_st3');
      // The card was created long ago, and blocked only now.
      state.storage.sql.exec(`UPDATE cards SET created_at = ? WHERE id = ?`, new Date(Date.now() - 100 * HOUR).toISOString(), ids.blocked);
      const stale = await b.staleCards({ nowIso: later(1) });
      expect(stale.find((s) => s.cardId === ids.blocked)).toBeUndefined();
    });
  });
});

describe('the daily digest', () => {
  it('is quiet when nothing is stale', async () => {
    await runInDurableObject(stubFor('digest-quiet'), async (b: BoardDO) => {
      await seeded(b, 'brd_dg1');
      const before = (await b.getNotifications()).length;
      await b.sweepBoard(later(1));
      expect((await b.getNotifications()).length).toBe(before);
      expect((await b.getEvents()).some((e) => e.type === 'cards.stale_digest')).toBe(false);
    });
  });

  it("tells each stale card's owner once, and not again the same day", async () => {
    await runInDurableObject(stubFor('digest-once'), async (b: BoardDO) => {
      const ids = await seeded(b, 'brd_dg2');
      await b.sweepBoard(later(25));
      const first = (await b.getNotifications()).filter((n) => n.kind === 'stale');
      expect(first.map((n) => n.cardId).sort()).toEqual([ids.intake, ids.blocked].sort());
      expect(first.every((n) => n.userId === 'usr_owner')).toBe(true);

      await b.sweepBoard(later(25.1));
      await b.sweepBoard(later(48));
      expect((await b.getNotifications()).filter((n) => n.kind === 'stale').length).toBe(2);

      // A day after the last one, still stuck: told again.
      await b.sweepBoard(later(49.5));
      expect((await b.getNotifications()).filter((n) => n.kind === 'stale').length).toBe(4);
    });
  });

  it('sends nothing for a board that switched it off', async () => {
    await runInDurableObject(stubFor('digest-off'), async (b: BoardDO) => {
      await seeded(b, 'brd_dg3');
      await b.setStaleSettings({ enabled: false });
      await b.sweepBoard(later(25));
      expect((await b.getNotifications()).filter((n) => n.kind === 'stale').length).toBe(0);
    });
  });

  it('queues one cards.stale delivery per digest to push configs that asked for it, and none to others', async () => {
    await runInDurableObject(stubFor('digest-push'), async (b: BoardDO, state) => {
      const ids = await seeded(b, 'brd_dg4');
      await b.registerPushConfig({ agentId: 'agt_room', url: 'https://hooks.example.com/room', token: 't', events: ['cards.stale'] });
      await b.registerPushConfig({ agentId: 'agt_work', url: 'https://hooks.example.com/work', token: 't', capabilities: ['build'] });
      const before = (await b.getPushDeliveries()).length;
      await b.sweepBoard(later(25));
      const fresh = (await b.getPushDeliveries()).slice(before);
      expect(fresh.length).toBe(1);
      expect(fresh[0]!.url).toBe('https://hooks.example.com/room');
      const body = JSON.parse(fresh[0]!.body) as { event: string; boardId: string; cards: Array<{ cardId: string }> };
      expect(body.event).toBe('cards.stale');
      expect(body.boardId).toBe('brd_dg4');
      expect(body.cards.map((c) => c.cardId).sort()).toEqual([ids.intake, ids.blocked].sort());

      await b.sweepBoard(later(26));
      expect((await b.getPushDeliveries()).length).toBe(before + 1);
      await state.storage.deleteAlarm();
    });
  });
});

// ── over HTTP: across the workspace ──────────────────────────────────────────────────────────────

const base = 'https://api.test';
const as = (tenant: string, user: string) => ({ 'X-Tenant-Id': tenant, 'X-User-Id': user, 'Content-Type': 'application/json' });

async function members(tenant: string, rows: Array<[string, string]>) {
  for (const [user, role] of rows) {
    await env.DB.prepare(`INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (?, ?, ?, ?)`)
      .bind(`mbr_${tenant}_${user}`, tenant, user, role)
      .run();
  }
}

async function boardWithIntakeCard(tenant: string, name: string) {
  const res = await SELF.fetch(`${base}/v1/boards`, { method: 'POST', headers: as(tenant, 'usr_owner'), body: JSON.stringify({ name, stages: STAGES }) });
  const boardId = (await res.json<{ boardId: string }>()).boardId;
  const card = await SELF.fetch(`${base}/v1/boards/${boardId}/cards`, { method: 'POST', headers: as(tenant, 'usr_owner'), body: JSON.stringify({ title: `${name} intake` }) });
  return { boardId, cardId: (await card.json<{ card: { id: string } }>()).card.id };
}

describe('GET /v1/stale', () => {
  it("lists stale cards across every board in the caller's workspace, and only theirs", async () => {
    const t = 'tnt_stale_ws';
    await members(t, [['usr_owner', 'owner'], ['usr_v', 'viewer']]);
    const a = await boardWithIntakeCard(t, 'Alpha');
    const z = await boardWithIntakeCard(t, 'Zulu');
    await members('tnt_stale_other', [['usr_owner', 'owner']]);
    await boardWithIntakeCard('tnt_stale_other', 'Elsewhere');

    const res = await SELF.fetch(`${base}/v1/stale?hours=0`, { headers: as(t, 'usr_v') });
    expect(res.status).toBe(200);
    const { cards, boardsUnanswered } = await res.json<{ cards: Array<{ boardId: string; cardId: string; why: { kind: string } }>; boardsUnanswered: number }>();
    expect(cards.map((c) => c.cardId).sort()).toEqual([a.cardId, z.cardId].sort());
    expect(cards.every((c) => c.why.kind === 'no-owner')).toBe(true);
    expect(boardsUnanswered).toBe(0);

    // The board's own threshold (24h) applies when none is given: nothing is that old yet.
    const dflt = await (await SELF.fetch(`${base}/v1/stale`, { headers: as(t, 'usr_v') })).json<{ cards: unknown[] }>();
    expect(dflt.cards).toEqual([]);

    // The Needs-you feed: intake cards are backlog until they pass the threshold.
    const attention = await (await SELF.fetch(`${base}/v1/stale?attention=1`, { headers: as(t, 'usr_v') })).json<{ cards: unknown[] }>();
    expect(attention.cards).toEqual([]);
  });

  it('refuses a non-member and a malformed threshold', async () => {
    const t = 'tnt_stale_refuse';
    await members(t, [['usr_owner', 'owner']]);
    await boardWithIntakeCard(t, 'A');
    expect((await SELF.fetch(`${base}/v1/stale`, { headers: as(t, 'usr_stranger') })).status).toBe(403);
    expect((await SELF.fetch(`${base}/v1/stale?hours=-2`, { headers: as(t, 'usr_owner') })).status).toBe(400);
    expect((await SELF.fetch(`${base}/v1/stale?hours=soon`, { headers: as(t, 'usr_owner') })).status).toBe(400);
  });

  it('PUT /v1/boards/:id/stale sets the threshold and the switch, as an admin', async () => {
    const t = 'tnt_stale_put';
    await members(t, [['usr_owner', 'owner'], ['usr_m', 'member']]);
    const { boardId } = await boardWithIntakeCard(t, 'A');
    const put = (user: string, body: unknown) =>
      SELF.fetch(`${base}/v1/boards/${boardId}/stale`, { method: 'PUT', headers: as(t, user), body: JSON.stringify(body) });
    expect((await put('usr_m', { afterHours: 1 })).status).toBe(403);
    expect((await put('usr_owner', { afterHours: 1, enabled: false })).status).toBe(200);
    const board = await (await SELF.fetch(`${base}/v1/boards/${boardId}`, { headers: as(t, 'usr_owner') })).json<{ stale: unknown }>();
    expect(board.stale).toEqual({ enabled: false, afterHours: 1 });
    expect((await put('usr_owner', { afterHours: 'a day' })).status).toBe(400);
  });
});

describe('the Needs-you feed (attention)', () => {
  it('lists every card waiting on a person at any age, and ownerless-stage cards only past the threshold', async () => {
    await runInDurableObject(stubFor('attention'), async (b: BoardDO) => {
      const ids = await seeded(b, 'brd_at1');
      const now = await b.staleCards({ nowIso: later(0), attention: true });
      expect(now.map((s) => s.cardId)).toEqual([ids.blocked]);
      const tomorrow = await b.staleCards({ nowIso: later(25), attention: true });
      expect(tomorrow.map((s) => s.cardId).sort()).toEqual([ids.intake, ids.blocked].sort());
      await b.setStaleSettings({ enabled: false });
      // Switched off: the ownerless reminder goes, a person's waiting card does not.
      expect((await b.staleCards({ nowIso: later(25), attention: true })).map((s) => s.cardId)).toEqual([ids.blocked]);
    });
  });

  it('carries what a pending review is about on the snapshot gate, and when each card stopped', async () => {
    await runInDurableObject(stubFor('attention-gate'), async (b: BoardDO) => {
      await b.init({ id: 'brd_at2', tenantId: 'tnt_stale', name: 'G', stages: STAGES });
      const c = await b.createCard({ title: 'Ship', ownerUserId: 'usr_owner' });
      if (!c.ok) throw new Error(c.message);
      await b.moveCard(c.value.id, 'build');
      const run = await b.claim(BUILDER);
      if (!run.claimed) throw new Error('expected claim');
      await b.complete({ runId: run.runId, leaseEpoch: run.leaseEpoch, handoff: { summary: 'Adds the login form <script>x</script>' } });
      const state = await b.getState();
      expect(state.gates[0]?.summary).toBe('Adds the login form <script>x</script>');
      expect(typeof state.cards[0]?.stateSince).toBe('string');
    });
  });
});
