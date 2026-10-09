import { describe, it, expect } from 'vitest';
import { buildLinkGroups, edgeKey } from './link-groups';

const titleOf = (id: string) => (id === 'card_y' ? 'Write the doc' : id === 'card_z' ? 'Ship it' : id);

describe('buildLinkGroups', () => {
  it('puts an enforced same-board blocker in `blockedBy`, badged ⛔', () => {
    const groups = buildLinkGroups('brd_1', 'card_c', [{ cardId: 'card_a', title: 'Fix the migration' }], [], [], titleOf);
    expect(groups.blockedBy).toHaveLength(1);
    expect(groups.blockedBy[0]!.badge.glyph).toBe('⛔');
    expect(groups.blockedBy[0]!.title).toBe('Fix the migration');
    expect(groups.blockedBy[0]!.remove).toEqual({ boardId: 'brd_1', fromCardId: 'card_a', toCardId: 'card_c', kind: 'blocks' });
  });

  it('renders an outgoing `blocks` edge in its own `blocks` group and produces NO ⛔ on this card', () => {
    const groups = buildLinkGroups(
      'brd_1',
      'card_c',
      [], // nothing blocks card_c — blockedBy is empty
      [{ fromCardId: 'card_c', toCardId: 'card_y', kind: 'blocks' }],
      [],
      titleOf,
    );
    expect(groups.blockedBy).toHaveLength(0); // no ⛔ on THIS card
    expect(groups.blocks).toHaveLength(1);
    expect(groups.blocks[0]!.cardId).toBe('card_y');
    expect(groups.blocks[0]!.title).toBe('Write the doc');
    expect(groups.blocks[0]!.kind).toBe('blocks');
    expect(groups.blocks[0]!.remove).toEqual({ boardId: 'brd_1', fromCardId: 'card_c', toCardId: 'card_y', kind: 'blocks' });
  });

  it('renders a `relates` edge and carries no enforcement language at all — no badge/tooltip field on the row', () => {
    const groups = buildLinkGroups('brd_1', 'card_c', [], [{ fromCardId: 'card_c', toCardId: 'card_y', kind: 'relates' }], [], titleOf);
    expect(groups.relates).toHaveLength(1);
    expect(groups.relates[0]!.title).toBe('Write the doc');
    expect(groups.relates[0]!.kind).toBe('relates');
    expect('badge' in groups.relates[0]!).toBe(false);
    expect('tooltip' in groups.relates[0]!).toBe(false);
  });

  it('resolves a `relates` edge from the OTHER direction too (this card as the to_card_id)', () => {
    const groups = buildLinkGroups('brd_1', 'card_c', [], [{ fromCardId: 'card_y', toCardId: 'card_c', kind: 'relates' }], [], titleOf);
    expect(groups.relates).toHaveLength(1);
    expect(groups.relates[0]!.cardId).toBe('card_y');
    expect(groups.relates[0]!.remove).toEqual({ boardId: 'brd_1', fromCardId: 'card_y', toCardId: 'card_c', kind: 'relates' });
  });

  it('puts an ENFORCED blocker and an ADVISORY blocker on the same card in their own groups, each with its own honest badge — the two never merge or borrow each other\'s glyph', () => {
    const groups = buildLinkGroups(
      'brd_1',
      'card_c',
      [{ cardId: 'card_a', title: 'Fix the migration' }],
      [],
      [
        {
          fromBoardId: 'brd_2',
          fromCardId: 'card_x',
          toBoardId: 'brd_1',
          toCardId: 'card_c',
          kind: 'blocks',
          otherCardTitle: 'Fix the layout',
          otherBoardName: 'Design board',
        },
      ],
      titleOf,
    );
    expect(groups.blockedBy).toHaveLength(1);
    expect(groups.advisory).toHaveLength(1);
    const glyphs = [groups.blockedBy[0]!.badge.glyph, groups.advisory[0]!.badge!.glyph].sort();
    expect(glyphs).toEqual(['⚑', '⛔']);
  });

  describe('resolvedBlockedBy — an inbound `blocks` edge whose blocker has already resolved', () => {
    it('gives a resolved inbound blocker its own home — visible and removable, but not ⛔', () => {
      // `links` carries the edge regardless of state (the DO never deletes it on resolution);
      // `blockedBy` (server-computed, unresolved only) does NOT carry it, since the blocker card
      // has already resolved. Without this group the edge is in `links` but in no group at all —
      // the exact "invisible and unremovable" defect this whole review is about, just for a
      // different subset of the same edge kind.
      const groups = buildLinkGroups(
        'brd_1',
        'card_c',
        [], // blockedBy is EMPTY — the blocker already resolved
        [{ fromCardId: 'card_a', toCardId: 'card_c', kind: 'blocks' }],
        [],
        titleOf,
      );
      expect(groups.blockedBy).toHaveLength(0); // never ⛔ for a resolved blocker
      expect(groups.resolvedBlockedBy).toHaveLength(1);
      expect(groups.resolvedBlockedBy[0]!.cardId).toBe('card_a');
      expect(groups.resolvedBlockedBy[0]!.remove).toEqual({ boardId: 'brd_1', fromCardId: 'card_a', toCardId: 'card_c', kind: 'blocks' });
      expect('badge' in groups.resolvedBlockedBy[0]!).toBe(false); // shown as resolved, not as ⛔
    });

    it('does NOT duplicate an unresolved blocker into `resolvedBlockedBy` — the two groups partition the same edge kind, never overlap', () => {
      const groups = buildLinkGroups(
        'brd_1',
        'card_c',
        [{ cardId: 'card_a', title: 'Fix the migration' }], // card_a is UNRESOLVED
        [{ fromCardId: 'card_a', toCardId: 'card_c', kind: 'blocks' }],
        [],
        titleOf,
      );
      expect(groups.blockedBy).toHaveLength(1);
      expect(groups.resolvedBlockedBy).toHaveLength(0);
    });
  });

  describe('edgeKey — derived from the edge\'s own identity, never the other card\'s id', () => {
    it('gives two DIFFERENT keys for mutual `relates` edges between the same pair of cards — the case that collided under a card-id key', () => {
      // `wouldCycle` deliberately excludes `relates` from its cycle check, and `addExternalLink`
      // has no cycle check at all, so A-relates-B and B-relates-A can BOTH exist. From card_a's
      // drawer, both rows resolve to "the other card is card_b" — a key built from `cardId` alone
      // collides, and Svelte 5 throws `each_key_duplicate` on a duplicate `{#each}` key.
      const groups = buildLinkGroups(
        'brd_1',
        'card_a',
        [],
        [
          { fromCardId: 'card_a', toCardId: 'card_b', kind: 'relates' },
          { fromCardId: 'card_b', toCardId: 'card_a', kind: 'relates' },
        ],
        [],
        titleOf,
      );
      expect(groups.relates).toHaveLength(2);
      expect(groups.relates.every((r) => r.cardId === 'card_b')).toBe(true); // same "other card" both times
      const keys = groups.relates.map((r) => edgeKey(r.remove));
      expect(keys[0]).not.toBe(keys[1]);
      expect(new Set(keys).size).toBe(2);
    });

    it('gives two DIFFERENT keys for an advisory row and a same-board row naming the same other card', () => {
      const groups = buildLinkGroups(
        'brd_1',
        'card_c',
        [{ cardId: 'card_a', title: 'Fix the migration' }],
        [],
        [
          {
            fromBoardId: 'brd_2',
            fromCardId: 'card_a', // same id as the same-board blocker, different board
            toBoardId: 'brd_1',
            toCardId: 'card_c',
            kind: 'blocks',
            otherCardTitle: 'Unrelated card on another board',
            otherBoardName: 'Design board',
          },
        ],
        titleOf,
      );
      const key1 = edgeKey(groups.blockedBy[0]!.remove);
      const key2 = edgeKey(groups.advisory[0]!.remove);
      expect(key1).not.toBe(key2);
    });
  });

  it('ignores `parent` edges entirely — those are the Sub-tasks section\'s job, not this one\'s', () => {
    const groups = buildLinkGroups(
      'brd_1',
      'card_c',
      [],
      [
        { fromCardId: 'card_c', toCardId: 'card_y', kind: 'parent' },
        { fromCardId: 'card_z', toCardId: 'card_c', kind: 'parent' },
      ],
      [],
      titleOf,
    );
    expect(groups.blocks).toHaveLength(0);
    expect(groups.relates).toHaveLength(0);
  });

  describe('advisory (cross-board)', () => {
    it('badges ⚑ "Blocked (advisory)" ONLY the subset that is `blocks` pointing AT this card', () => {
      const groups = buildLinkGroups(
        'brd_1',
        'card_c',
        [],
        [],
        [
          {
            fromBoardId: 'brd_2',
            fromCardId: 'card_x',
            toBoardId: 'brd_1',
            toCardId: 'card_c',
            kind: 'blocks',
            otherCardTitle: 'Fix the layout',
            otherBoardName: 'Design board',
          },
        ],
        titleOf,
      );
      expect(groups.advisory).toHaveLength(1);
      const row = groups.advisory[0]!;
      expect(row.relation).toBe('blocked-by');
      expect(row.badge).not.toBeNull();
      expect(row.badge!.glyph).toBe('⚑');
      expect(row.badge!.tooltip).toBe('Blocked by Fix the layout on Design board — not enforced across boards');
      // The remove call must target the FROM board (brd_2) — where `fromCardId` actually lives —
      // not this card's own board, per addLink/removeLink's asymmetric contract.
      expect(row.remove).toEqual({
        boardId: 'brd_2',
        fromCardId: 'card_x',
        toCardId: 'card_c',
        kind: 'blocks',
        toBoardId: 'brd_1',
      });
    });

    it('gives NO badge (and no "Blocked" language) to an outgoing cross-board `blocks` edge', () => {
      const groups = buildLinkGroups(
        'brd_1',
        'card_c',
        [],
        [],
        [
          {
            fromBoardId: 'brd_1',
            fromCardId: 'card_c',
            toBoardId: 'brd_2',
            toCardId: 'card_x',
            kind: 'blocks',
            otherCardTitle: 'Fix the layout',
            otherBoardName: 'Design board',
          },
        ],
        titleOf,
      );
      const row = groups.advisory[0]!;
      expect(row.relation).toBe('blocks');
      expect(row.badge).toBeNull();
      expect(row.remove).toEqual({
        boardId: 'brd_1',
        fromCardId: 'card_c',
        toCardId: 'card_x',
        kind: 'blocks',
        toBoardId: 'brd_2',
      });
    });

    it('gives NO badge to a cross-board `relates` edge, regardless of direction', () => {
      const groups = buildLinkGroups(
        'brd_1',
        'card_c',
        [],
        [],
        [
          {
            fromBoardId: 'brd_2',
            fromCardId: 'card_x',
            toBoardId: 'brd_1',
            toCardId: 'card_c',
            kind: 'relates',
            otherCardTitle: 'Fix the layout',
            otherBoardName: 'Design board',
          },
        ],
        titleOf,
      );
      const row = groups.advisory[0]!;
      expect(row.relation).toBe('relates');
      expect(row.badge).toBeNull();
    });

    it('falls back to the card id when otherCardTitle is null, for both the title and the badge tooltip', () => {
      const groups = buildLinkGroups(
        'brd_1',
        'card_c',
        [],
        [],
        [
          {
            fromBoardId: 'brd_2',
            fromCardId: 'card_x7f2',
            toBoardId: 'brd_1',
            toCardId: 'card_c',
            kind: 'blocks',
            otherCardTitle: null,
            otherBoardName: 'Design board',
          },
        ],
        titleOf,
      );
      const row = groups.advisory[0]!;
      expect(row.title).toBe('card_x7f2');
      expect(row.badge!.tooltip).toBe('Blocked by card_x7f2 on Design board — not enforced across boards');
    });
  });
});

describe('supersedes edges', () => {
  it('groups a same-board supersedes edge with its direction, in neither blocks nor relates', () => {
    const edge = { fromCardId: 'card_new', toCardId: 'card_old', kind: 'supersedes' };
    const asNew = buildLinkGroups('brd_1', 'card_new', [], [edge], [], titleOf);
    const asOld = buildLinkGroups('brd_1', 'card_old', [], [edge], [], titleOf);
    expect(asNew.supersedes).toMatchObject([{ cardId: 'card_old', direction: 'supersedes', remove: { kind: 'supersedes', fromCardId: 'card_new', toCardId: 'card_old' } }]);
    expect(asOld.supersedes).toMatchObject([{ cardId: 'card_new', direction: 'superseded-by' }]);
    for (const g of [asNew, asOld]) {
      expect(g.blocks).toHaveLength(0);
      expect(g.relates).toHaveLength(0);
      expect(g.blockedBy).toHaveLength(0);
    }
  });
});
