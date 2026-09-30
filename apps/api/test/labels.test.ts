import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { createLabel, listLabels, deleteLabel, unknownLabelIds, resolveLabelNames } from '../src/db/labels';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_lbl', 'labels', 'Labels')`).run();
});

describe('label catalogue', () => {
  it('refuses a second label with the same name in one tenant', async () => {
    await createLabel(env.DB, 'tnt_lbl', { name: 'urgent', colour: '#f00' });
    await expect(createLabel(env.DB, 'tnt_lbl', { name: 'urgent', colour: '#0f0' })).rejects.toThrow();
  });

  // Uniqueness is now case-insensitive (migration 0011: `labels_tenant_name_nocase`), so a
  // duplicate that differs only in case is refused the same way an exact duplicate is — the
  // same collision `resolveLabelNames` below relies on being unable to create.
  it('refuses a duplicate that differs only in case', async () => {
    await createLabel(env.DB, 'tnt_lbl', { name: 'Blocked', colour: '#f00' });
    await expect(createLabel(env.DB, 'tnt_lbl', { name: 'blocked', colour: '#0f0' })).rejects.toThrow();
  });

  it('is tenant-scoped', async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_other', 'other', 'Other')`).run();
    await createLabel(env.DB, 'tnt_other', { name: 'urgent', colour: '#00f' });
    const mine = await listLabels(env.DB, 'tnt_lbl');
    expect(mine.filter((l) => l.name === 'urgent')).toHaveLength(1);
  });

  it('reports unknown ids, so a card cannot carry a label that does not exist', async () => {
    const live = await createLabel(env.DB, 'tnt_lbl', { name: 'chore', colour: '#888' });
    expect(await unknownLabelIds(env.DB, 'tnt_lbl', [live.id, 'lbl_deadbeefdeadbeef'])).toEqual([
      'lbl_deadbeefdeadbeef',
    ]);
  });
});

describe('resolveLabelNames — the drawer input resolved against the catalogue', () => {
  it('returns two ids for one existing name and one new name, creating exactly one row', async () => {
    const t = 'tnt_lbl_resolve';
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, 'lbl-resolve', 'Resolve')`).bind(t).run();
    const pre = await createLabel(env.DB, t, { name: 'bug', colour: '#f00' });
    const before = await listLabels(env.DB, t);

    const ids = await resolveLabelNames(env.DB, t, ['bug', 'frontend'], 'usr_a');
    expect(ids).toHaveLength(2);
    expect(ids).toContain(pre.id);

    const after = await listLabels(env.DB, t);
    expect(after).toHaveLength(before.length + 1);
    const created = after.find((l) => l.name === 'frontend');
    expect(created).toBeDefined();
    expect(ids).toContain(created!.id);
  });

  it('creates nothing the second time the same names are resolved', async () => {
    const t = 'tnt_lbl_resolve_idem';
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, 'lbl-resolve-idem', 'Idem')`).bind(t).run();

    const first = await resolveLabelNames(env.DB, t, ['chore', 'docs'], 'usr_a');
    const afterFirst = await listLabels(env.DB, t);

    const second = await resolveLabelNames(env.DB, t, ['chore', 'docs'], 'usr_a');
    const afterSecond = await listLabels(env.DB, t);

    expect(second.slice().sort()).toEqual(first.slice().sort());
    expect(afterSecond).toHaveLength(afterFirst.length);
  });

  it('resolves "Urgent" and "urgent" to the same id, not two', async () => {
    const t = 'tnt_lbl_resolve_case';
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, 'lbl-resolve-case', 'Case')`).bind(t).run();

    const ids = await resolveLabelNames(env.DB, t, ['Urgent', 'urgent'], 'usr_a');
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);

    const rows = await listLabels(env.DB, t);
    expect(rows.filter((l) => l.name.toLowerCase() === 'urgent')).toHaveLength(1);
  });

  it('registers a newly created name as inferred, and matches an already-declared one without changing its origin', async () => {
    const t = 'tnt_lbl_resolve_origin';
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES (?, 'lbl-resolve-origin', 'Origin')`).bind(t).run();
    await createLabel(env.DB, t, { name: 'declared-already', colour: '#00f' });

    await resolveLabelNames(env.DB, t, ['declared-already', 'brand-new'], 'usr_a');

    const rows = await env.DB.prepare(`SELECT name, origin, created_by FROM labels WHERE tenant_id = ?`).bind(t).all<{
      name: string;
      origin: string;
      created_by: string | null;
    }>();
    const declared = rows.results!.find((r) => r.name === 'declared-already')!;
    const inferred = rows.results!.find((r) => r.name === 'brand-new')!;
    expect(declared.origin).toBe('declared');
    expect(inferred.origin).toBe('inferred');
    expect(inferred.created_by).toBe('usr_a');
  });
});

describe('applying labels to a card', () => {
  it('stores ids and reads them back', async () => {
    const label = await createLabel(env.DB, 'tnt_lbl', { name: 'blog', colour: '#ff0' });
    await runInDurableObject(stubFor('lbl-apply'), async (board: BoardDO) => {
      await board.init({ id: 'brd_lbl', tenantId: 'tnt_lbl', name: 'L', stages: STAGES });
      const created = await board.createCard({ title: 'Post', ownerUserId: 'usr_a' });
      if (!created.ok) throw new Error(created.message);
      const updated = await board.updateCard(created.value.id, { labels: [label.id] });
      if (!updated.ok) throw new Error(updated.message);
      expect(updated.value.labels).toEqual([label.id]);
    });
  });

  it('ignores an id whose label was deleted, rather than failing to render the card', async () => {
    const doomed = await createLabel(env.DB, 'tnt_lbl', { name: 'temporary', colour: '#ccc' });
    await runInDurableObject(stubFor('lbl-stale'), async (board: BoardDO) => {
      await board.init({ id: 'brd_lbl2', tenantId: 'tnt_lbl', name: 'L2', stages: STAGES });
      const created = await board.createCard({ title: 'Post', ownerUserId: 'usr_a' });
      if (!created.ok) throw new Error(created.message);
      await board.updateCard(created.value.id, { labels: [doomed.id] });
      expect(await deleteLabel(env.DB, 'tnt_lbl', doomed.id)).toBe(true);
      // The card still reads: a stale id is a cosmetic condition, not a broken card.
      const card = (await board.getState()).cards[0]!;
      expect(card.labels).toEqual([doomed.id]);
    });
  });
});
