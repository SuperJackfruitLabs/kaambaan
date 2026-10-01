import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { addExternalLink, listExternalLinksFor, removeExternalLink } from '../src/db/card-links-external';

const A = { boardId: 'brd_press', cardId: 'card_aaaaaaaaaaaaaaaa' };
const B = { boardId: 'brd_releases', cardId: 'card_bbbbbbbbbbbbbbbb' };

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_x', 'x', 'X')`).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_y', 'y', 'Y')`).run();
  // Both fixture boards must EXIST and belong to tnt_x: the migration FKs the board ids and
  // `addExternalLink` checks tenant ownership of both ends.
  for (const b of [A.boardId, B.boardId]) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json) VALUES (?, 'tnt_x', ?, '[]')`,
    ).bind(b, b).run();
  }
});

describe('cross-board edges', () => {
  it('accepts an edge between two different boards', async () => {
    const r = await addExternalLink(env.DB, 'tnt_x', { from: A, to: B, kind: 'blocks' });
    expect(r.ok).toBe(true);
  });

  it('refuses a same-board edge — those belong in the DO, where they can be enforced', async () => {
    const r = await addExternalLink(env.DB, 'tnt_x', {
      from: A,
      to: { boardId: A.boardId, cardId: 'card_cccccccccccccccc' },
      kind: 'blocks',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SAME_BOARD_EDGE');
      expect(r.message).toContain('card_links');
    }
    // This is the important one. Two places to store the same edge — one enforced, one not — is
    // how an enforced rule quietly stops being enforced: someone writes the advisory row, the
    // claim path never reads it, and the UI shows a badge that does nothing.
  });

  it('refuses kind=parent, and says why rather than just rejecting', async () => {
    const r = await addExternalLink(env.DB, 'tnt_x', { from: A, to: B, kind: 'parent' as never });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('PARENT_MUST_BE_SAME_BOARD');
      expect(r.message).toContain('project');
    }
  });

  it('is tenant-scoped: another tenant cannot see the edge', async () => {
    await addExternalLink(env.DB, 'tnt_x', { from: A, to: B, kind: 'relates' });
    expect(await listExternalLinksFor(env.DB, 'tnt_x', B.cardId)).not.toHaveLength(0);
    expect(await listExternalLinksFor(env.DB, 'tnt_y', B.cardId)).toHaveLength(0);
  });

  it('finds the edge from EITHER end, not just the one it points at', async () => {
    await addExternalLink(env.DB, 'tnt_x', { from: A, to: B, kind: 'blocks' });
    // The card that DECLARES the edge has to show a badge too. Querying only `to_card_id` makes a
    // card's own outgoing blockers invisible on the card that owns them.
    expect(await listExternalLinksFor(env.DB, 'tnt_x', A.cardId)).not.toHaveLength(0);
  });

  it('refuses an edge into a board belonging to another tenant', async () => {
    // `boards` is in D1 with a `tenant_id`, so this is checkable rather than assumed. Without the
    // check, a tenant names any board id it likes and reads back rows about a board it cannot see.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json) VALUES ('brd_theirs', 'tnt_y', 'Theirs', '[]')`,
    ).run();
    const r = await addExternalLink(env.DB, 'tnt_x', {
      from: A,
      to: { boardId: 'brd_theirs', cardId: 'card_dddddddddddddddd' },
      kind: 'blocks',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('FOREIGN_BOARD');
  });

  it('is idempotent on the same triple, rather than duplicating the badge', async () => {
    await addExternalLink(env.DB, 'tnt_x', { from: A, to: B, kind: 'relates' });
    await addExternalLink(env.DB, 'tnt_x', { from: A, to: B, kind: 'relates' });
    const found = (await listExternalLinksFor(env.DB, 'tnt_x', B.cardId)).filter(
      (l) => l.kind === 'relates',
    );
    expect(found).toHaveLength(1);
  });
});

describe('removeExternalLink', () => {
  // Fresh card ids on the same, already-fixtured boards — so ownership/FK are already satisfied,
  // and these rows don't collide with the edges the suite above already created on A/B.
  const C = { boardId: A.boardId, cardId: 'card_eeeeeeeeeeeeeeee' };
  const D = { boardId: B.boardId, cardId: 'card_ffffffffffffffff' };

  it('removes an edge: listExternalLinksFor no longer returns it afterward', async () => {
    await addExternalLink(env.DB, 'tnt_x', { from: C, to: D, kind: 'blocks' });
    expect(
      (await listExternalLinksFor(env.DB, 'tnt_x', D.cardId)).filter(
        (l) => l.fromCardId === C.cardId && l.toCardId === D.cardId && l.kind === 'blocks',
      ),
    ).toHaveLength(1);

    await removeExternalLink(env.DB, 'tnt_x', C.cardId, D.cardId, 'blocks');

    expect(
      (await listExternalLinksFor(env.DB, 'tnt_x', D.cardId)).filter(
        (l) => l.fromCardId === C.cardId && l.toCardId === D.cardId && l.kind === 'blocks',
      ),
    ).toHaveLength(0);
  });

  it('is tenant-scoped: removing with a DIFFERENT tenant id leaves the row untouched', async () => {
    // The tenant predicate on the delete is the part worth proving — a missing one would be a
    // cross-tenant WRITE (tnt_y deleting a row it cannot even see), which is worse than a
    // cross-tenant read.
    await addExternalLink(env.DB, 'tnt_x', { from: C, to: D, kind: 'relates' });

    await removeExternalLink(env.DB, 'tnt_y', C.cardId, D.cardId, 'relates');

    expect(
      (await listExternalLinksFor(env.DB, 'tnt_x', D.cardId)).filter(
        (l) => l.fromCardId === C.cardId && l.toCardId === D.cardId && l.kind === 'relates',
      ),
    ).toHaveLength(1);

    // Clean up with the correct tenant so this row doesn't leak into later assertions.
    await removeExternalLink(env.DB, 'tnt_x', C.cardId, D.cardId, 'relates');
  });

  it('removing a triple that was never added does not throw — idempotent delete', async () => {
    await expect(
      removeExternalLink(env.DB, 'tnt_x', 'card_never_added_1', 'card_never_added_2', 'blocks'),
    ).resolves.toBeUndefined();
  });
});
