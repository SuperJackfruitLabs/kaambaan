import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit, type CardView } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function make(board: BoardDO, title: string, patch: { priority?: number; dueAt?: string }): Promise<CardView> {
  const r = await board.createCard({ title, ownerUserId: 'usr_a', priority: patch.priority ?? 0 });
  if (!r.ok) throw new Error(r.message);
  if (patch.dueAt) {
    const u = await board.updateCard(r.value.id, { dueAt: patch.dueAt });
    if (!u.ok) throw new Error(u.message);
    return u.value;
  }
  return r.value;
}

describe('due dates in claim order', () => {
  it('prefers the sooner due date at equal priority', async () => {
    await runInDurableObject(stubFor('due-order'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due', tenantId: 'tnt_a', name: 'D', stages: STAGES });
      const later = await make(board, 'Later', { dueAt: '2026-12-01' });
      const sooner = await make(board, 'Sooner', { dueAt: '2026-10-01' });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(sooner.id);
      expect(claim.card.id).not.toBe(later.id);
    });
  });

  it('never lets a due date outrank priority', async () => {
    await runInDurableObject(stubFor('due-vs-pri'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due2', tenantId: 'tnt_a', name: 'D2', stages: STAGES });
      await make(board, 'Due tomorrow, low priority', { priority: 0, dueAt: '2026-10-01' });
      const urgent = await make(board, 'No due date, high priority', { priority: 5 });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(urgent.id);
    });
  });

  it('puts undated cards last, not first', async () => {
    await runInDurableObject(stubFor('due-nulls'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due3', tenantId: 'tnt_a', name: 'D3', stages: STAGES });
      await make(board, 'Undated', {});
      const dated = await make(board, 'Dated', { dueAt: '2027-01-01' });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(dated.id);
    });
  });

  it('does not hand out an archived card', async () => {
    await runInDurableObject(stubFor('due-archived'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due4', tenantId: 'tnt_a', name: 'D4', stages: STAGES });
      const card = await make(board, 'Archived', {});
      await board.updateCard(card.id, { archivedAt: '2026-09-30T00:00:00.000Z' });
      expect((await board.claim({ agentId: 'agt_w', capabilities: ['writing'] })).claimed).toBe(false);
    });
  });

  it('does not ADVERTISE an archived card either — discovery and claim must agree', async () => {
    await runInDurableObject(stubFor('due-archived-count'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due4b', tenantId: 'tnt_a', name: 'D4b', stages: STAGES });
      const card = await make(board, 'Archived', {});
      expect(await board.countReadyForCapabilities('agt_w', ['writing'])).toBe(1);

      await board.updateCard(card.id, { archivedAt: '2026-09-30T00:00:00.000Z' });

      // `countReadyForCapabilities` is what `superpipeline_list_work` reports as `readyForYou`.
      // If it still says 1 while claim says nothing is claimable, an agent polls, sees work, claims
      // nothing, and polls again — forever.
      expect(await board.countReadyForCapabilities('agt_w', ['writing'])).toBe(0);
      expect((await board.claim({ agentId: 'agt_w', capabilities: ['writing'] })).claimed).toBe(false);
    });
  });
});

describe('overdue notification', () => {
  it('notifies the owner once, not once per tick', async () => {
    await runInDurableObject(stubFor('due-notify'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due5', tenantId: 'tnt_a', name: 'D5', stages: STAGES });
      await make(board, 'Overdue', { dueAt: '2026-09-01' });

      const first = await board.sweepBoard('2026-09-30T10:00:00.000Z');
      expect(first.overdueNotified).toBe(1);

      const second = await board.sweepBoard('2026-09-30T10:05:00.000Z');
      expect(second.overdueNotified).toBe(0);

      const notes = (await board.getNotifications()).filter((n) => n.kind === 'overdue');
      expect(notes).toHaveLength(1);
    });
  });

  it('resets the notified flag when the due date actually changes, allowing a second notification', async () => {
    // Unlike the case above, `updateCard` here moves an ALREADY-notified card to a new (still
    // past) due date, so `overdue_notified_at` starts non-NULL and this exercises the reset as a
    // reset, not as a no-op on a column that was already NULL.
    await runInDurableObject(stubFor('due-reset'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due8', tenantId: 'tnt_a', name: 'D8', stages: STAGES });
      const card = await make(board, 'Overdue twice', { dueAt: '2026-09-01' });

      expect((await board.sweepBoard('2026-09-30T10:00:00.000Z')).overdueNotified).toBe(1);

      const u = await board.updateCard(card.id, { dueAt: '2026-09-15' });
      if (!u.ok) throw new Error(u.message);

      expect((await board.sweepBoard('2026-09-30T10:05:00.000Z')).overdueNotified).toBe(1);

      const notes = (await board.getNotifications()).filter((n) => n.kind === 'overdue');
      expect(notes).toHaveLength(2);
    });
  });

  it('does not re-arm the notification when an edit resends the SAME due date (CardDrawer sends dueAt on every save)', async () => {
    await runInDurableObject(stubFor('due-unrelated-edit'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due14', tenantId: 'tnt_a', name: 'D14', stages: STAGES });
      const card = await make(board, 'Overdue', { dueAt: '2026-09-01' });

      expect((await board.sweepBoard('2026-09-30T10:00:00.000Z')).overdueNotified).toBe(1);

      // An unrelated field changes (a title edit), but the client resends the SAME dueAt it
      // already had — exactly what CardDrawer.svelte does on every save, not only a due-date edit.
      const u = await board.updateCard(card.id, { title: 'Overdue (retitled)', dueAt: '2026-09-01' });
      if (!u.ok) throw new Error(u.message);

      // No second notification: the value never actually changed.
      expect((await board.sweepBoard('2026-09-30T10:05:00.000Z')).overdueNotified).toBe(0);

      const notes = (await board.getNotifications()).filter((n) => n.kind === 'overdue');
      expect(notes).toHaveLength(1);
    });
  });

  it('says nothing about a card that is not yet due', async () => {
    await runInDurableObject(stubFor('due-future'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due6', tenantId: 'tnt_a', name: 'D6', stages: STAGES });
      await make(board, 'Future', { dueAt: '2027-01-01' });
      expect((await board.sweepBoard('2026-09-30T10:00:00.000Z')).overdueNotified).toBe(0);
    });
  });

  it('says nothing about an overdue card that is already finished', async () => {
    await runInDurableObject(stubFor('due-done'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due7', tenantId: 'tnt_a', name: 'D7', stages: STAGES });
      const card = await make(board, 'Done but late', { dueAt: '2026-09-01' });
      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed) throw new Error('expected a claim');
      await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'late but done' } });
      expect(card.id).toBeDefined();
      expect((await board.sweepBoard('2026-09-30T10:00:00.000Z')).overdueNotified).toBe(0);
    });
  });
});

describe('sweepBoard runs the due-date backfill once per board', () => {
  it('migrates spec.due on the first sweep, nothing on the second, and the flag survives', async () => {
    await runInDurableObject(stubFor('due-backfill-sweep'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due9', tenantId: 'tnt_a', name: 'D9', stages: STAGES });
      const created = await board.createCard({
        title: 'Legacy card',
        ownerUserId: 'usr_a',
        spec: { due: '2026-08-01', description: 'kept' },
      });
      if (!created.ok) throw new Error(created.message);
      // Simulate the pre-migration world: the column is cleared, the blob keeps the value.
      await board.__testResetDueToSpec(created.value.id);

      const before = (await board.getState()).cards[0]!;
      expect(before.dueAt).toBeNull();

      await board.sweepBoard('2026-09-30T10:00:00.000Z');

      const migrated = (await board.getState()).cards[0]!;
      expect(migrated.dueAt).toBe('2026-08-01');
      expect((migrated.spec as Record<string, unknown>).due).toBeUndefined();
      expect((migrated.spec as Record<string, unknown>).description).toBe('kept');

      const events = await board.getEvents();
      expect(events.filter((e) => e.type === 'cards.due_backfilled')).toHaveLength(1);

      // Put another spec.due-only card in place, as if it arrived after the first sweep — the
      // second sweep must not touch it, because the backfill has already run for this board.
      const second = await board.createCard({
        title: 'Also legacy',
        ownerUserId: 'usr_a',
        spec: { due: '2026-08-02' },
      });
      if (!second.ok) throw new Error(second.message);
      await board.__testResetDueToSpec(second.value.id);

      await board.sweepBoard('2026-09-30T10:05:00.000Z');

      const untouched = (await board.getState()).cards.find((c) => c.id === second.value.id)!;
      expect(untouched.dueAt).toBeNull();
      // NOT '2026-08-02': `createCard` strips the stale `spec.due` key on write once the
      // once-per-board backfill has already run (finding 9) rather than letting it sit there
      // forever — the second sweep's `WHERE due_at IS NULL` guard will never revisit this card, so
      // a surviving raw key would be permanent, not merely unmigrated.
      expect((untouched.spec as Record<string, unknown>).due).toBeUndefined();

      const eventsAfter = await board.getEvents();
      expect(eventsAfter.filter((e) => e.type === 'cards.due_backfilled')).toHaveLength(1);
    });
  });
});

describe('createCard accepts a due date directly', () => {
  it('sets due_at from input.dueAt without a follow-up patch', async () => {
    await runInDurableObject(stubFor('due-create'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due10', tenantId: 'tnt_a', name: 'D10', stages: STAGES });
      const created = await board.createCard({ title: 'Dated at birth', ownerUserId: 'usr_a', dueAt: '2026-11-01' });
      if (!created.ok) throw new Error(created.message);
      expect(created.value.dueAt).toBe('2026-11-01');
    });
  });
});

describe('sweepBoard also migrates spec.labels, under the same guard', () => {
  it('one sweep migrates a card carrying both spec.due and spec.labels', async () => {
    // `labels` (migration 0010) carries `REFERENCES tenants(id)`, unlike the tables this suite's
    // boards otherwise touch — so resolving a label name needs a real tenant row first.
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_a', 'due-dates', 'Due Dates')`).run();

    await runInDurableObject(stubFor('due-labels-backfill'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due11', tenantId: 'tnt_a', name: 'D11', stages: STAGES });
      const created = await board.createCard({
        title: 'Legacy card',
        ownerUserId: 'usr_a',
        // Both legacy facts on the one card — `due` the pre-Task-6 shape, `labels` the free-text
        // shape `CardDrawer.svelte` wrote before this branch pointed it at the catalogue.
        spec: { due: '2026-08-05', labels: ['bug', 'Urgent'], description: 'kept' },
      });
      if (!created.ok) throw new Error(created.message);

      const before = (await board.getState()).cards[0]!;
      expect(before.dueAt).toBeNull();
      expect(before.labels).toEqual([]);

      await board.sweepBoard('2026-09-30T10:00:00.000Z');

      const migrated = (await board.getState()).cards[0]!;
      expect(migrated.dueAt).toBe('2026-08-05');
      expect((migrated.spec as Record<string, unknown>).due).toBeUndefined();
      expect((migrated.spec as Record<string, unknown>).labels).toBeUndefined();
      expect((migrated.spec as Record<string, unknown>).description).toBe('kept');
      expect(migrated.labels).toHaveLength(2);

      const rows = await env.DB.prepare(`SELECT name FROM labels WHERE tenant_id = 'tnt_a'`).all<{ name: string }>();
      const names = (rows.results ?? []).map((r) => r.name);
      expect(names).toContain('bug');
      expect(names).toContain('Urgent');
    });
  });

  it('does not set the backfill flag when the labels half of the pass throws, so the next sweep retries', async () => {
    // No `tenants` row for this id yet: `labels` (migration 0010) carries `REFERENCES tenants(id)`,
    // so `resolveLabelNames`' INSERT fails on that FK — the real way this pass can fail, not a
    // mock. This is the same FK `test/labels-rest.test.ts` documents relying on.
    await runInDurableObject(stubFor('due-labels-backfill-fails'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due13', tenantId: 'tnt_backfill_retry', name: 'D13', stages: STAGES });
      const created = await board.createCard({
        title: 'Legacy card',
        ownerUserId: 'usr_a',
        spec: { labels: ['bug'] },
      });
      if (!created.ok) throw new Error(created.message);

      await expect(board.sweepBoard('2026-09-30T10:00:00.000Z')).rejects.toThrow();

      // Proof the flag was never set: with nothing else changed but a `tenants` row now existing,
      // the SAME once-per-board pass runs again and actually migrates the card. If the flag had
      // been set on the failed attempt, this second sweep would see nothing left to migrate and
      // the card would still carry `spec.labels` forever.
      await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_backfill_retry', 'retry', 'Retry')`).run();
      await board.sweepBoard('2026-09-30T10:05:00.000Z');

      const migrated = (await board.getState()).cards[0]!;
      expect(migrated.labels).toHaveLength(1);
      expect((migrated.spec as Record<string, unknown>).labels).toBeUndefined();
      const events = await board.getEvents();
      expect(events.filter((e) => e.type === 'cards.labels_backfilled')).toHaveLength(1);
    });
  });

  it('still sends the SAME sweep\'s overdue notifications when the backfill throws', async () => {
    // No `tenants` row for this tenant id — same FK failure the previous test relies on, the real
    // way `backfillLabelNames` can fail, not a mock. Before the fix, this failure threw BEFORE the
    // overdue query at all, so a board that can never backfill successfully would never send an
    // overdue notification either, forever — on top of the empty-catch in `scheduled()` making
    // that failure invisible everywhere.
    await runInDurableObject(stubFor('due-backfill-fails-still-notifies'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due16', tenantId: 'tnt_backfill_retry_notify', name: 'D16', stages: STAGES });
      const created = await board.createCard({
        title: 'Legacy labels + overdue',
        ownerUserId: 'usr_a',
        spec: { labels: ['bug'] }, // makes backfillLabelNames attempt (and fail) its FK insert
      });
      if (!created.ok) throw new Error(created.message);
      const dueSet = await board.updateCard(created.value.id, { dueAt: '2026-09-01' });
      if (!dueSet.ok) throw new Error(dueSet.message);

      await expect(board.sweepBoard('2026-09-30T10:00:00.000Z')).rejects.toThrow();

      const notes = (await board.getNotifications()).filter((n) => n.kind === 'overdue');
      expect(notes).toHaveLength(1);
    });
  });

  it('does not touch a second board\'s legacy spec.labels on a second sweep — same once-per-board flag', async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_a', 'due-dates', 'Due Dates')`).run();

    await runInDurableObject(stubFor('due-labels-backfill-twice'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due12', tenantId: 'tnt_a', name: 'D12', stages: STAGES });
      const first = await board.createCard({ title: 'First', ownerUserId: 'usr_a', spec: { labels: ['chore'] } });
      if (!first.ok) throw new Error(first.message);

      await board.sweepBoard('2026-09-30T10:00:00.000Z');
      expect((await board.getState()).cards[0]!.labels).toHaveLength(1);

      const second = await board.createCard({ title: 'Second', ownerUserId: 'usr_a', spec: { labels: ['docs'] } });
      if (!second.ok) throw new Error(second.message);

      await board.sweepBoard('2026-09-30T10:05:00.000Z');

      const untouched = (await board.getState()).cards.find((c) => c.id === second.value.id)!;
      expect(untouched.labels).toEqual([]);
      // NOT ['docs']: `createCard` strips the stale `spec.labels` key on write (finding 9) rather
      // than letting it sit there forever — the once-per-board backfill (`WHERE due_at IS NULL`
      // equivalent guard) will never revisit this card, so a surviving raw key would be permanent,
      // not merely unmigrated.
      expect((untouched.spec as Record<string, unknown>).labels).toBeUndefined();
    });
  });
});

describe('createCard/updateCard strip the stale spec.due/spec.labels keys on write (finding 9)', () => {
  it('createCard never stores spec.due or spec.labels, even after the once-per-board backfill has already run', async () => {
    await runInDurableObject(stubFor('spec-strip-create'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due17', tenantId: 'tnt_spec_strip_create', name: 'D17', stages: STAGES });

      // Run the backfill pass once, on a board with nothing to migrate — so `dueBackfillDone` is
      // set and any FRESH card carrying `spec.due`/`spec.labels` from here on is exactly the
      // post-backfill scenario finding 9 describes: an API or MCP caller re-creating the old
      // locations, which the once-per-board guard can never reach again.
      await board.sweepBoard('2026-09-30T10:00:00.000Z');

      const created = await board.createCard({
        title: 'Fresh card with stale spec keys',
        ownerUserId: 'usr_a',
        spec: { due: '2026-08-01', labels: ['bug'], description: 'kept' },
      });
      if (!created.ok) throw new Error(created.message);

      const spec = created.value.spec as Record<string, unknown>;
      expect(spec.due).toBeUndefined();
      expect(spec.labels).toBeUndefined();
      expect(spec.description).toBe('kept');
    });
  });

  it('updateCard strips spec.due/spec.labels from a spec write, same as createCard', async () => {
    await runInDurableObject(stubFor('spec-strip-update'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due18', tenantId: 'tnt_spec_strip_update', name: 'D18', stages: STAGES });
      const created = await board.createCard({ title: 'Plain card', ownerUserId: 'usr_a' });
      if (!created.ok) throw new Error(created.message);
      // Same "after the backfill has already run" precondition as the createCard test above —
      // before that pass, a card legitimately carries these keys, and stripping must not fire.
      await board.sweepBoard('2026-09-30T10:00:00.000Z');

      const updated = await board.updateCard(created.value.id, {
        spec: { due: '2026-08-01', labels: ['bug'], description: 'kept' },
      });
      if (!updated.ok) throw new Error(updated.message);

      const spec = updated.value.spec as Record<string, unknown>;
      expect(spec.due).toBeUndefined();
      expect(spec.labels).toBeUndefined();
      expect(spec.description).toBe('kept');
    });
  });
});
