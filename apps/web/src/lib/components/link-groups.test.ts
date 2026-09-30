import { describe, it, expect } from 'vitest';
import { buildLinkGroups } from './link-groups';

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
