import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { isResolved, wouldCycle, type LinkRow } from '../src/board/links';
import { TERMINAL_STATES, isTerminal } from '@superpipeline/contract';
import { BoardDO, type BoardInit } from '../src/board/board-do';

describe('isResolved', () => {
  it('treats completed and canceled as resolved', () => {
    expect(isResolved('completed')).toBe(true);
    expect(isResolved('canceled')).toBe(true);
  });

  it('does NOT treat failed or rejected as resolved — a blocker that failed still blocks', () => {
    expect(isResolved('failed')).toBe(false);
    expect(isResolved('rejected')).toBe(false);
  });

  it('is deliberately not isTerminal — this test exists to stop someone "simplifying" it', () => {
    const disagreements = TERMINAL_STATES.filter((s) => isTerminal(s) !== isResolved(s));
    expect(disagreements).toEqual(['rejected', 'failed']);
  });

  it('treats work in progress as unresolved', () => {
    for (const s of ['submitted', 'working', 'input-required', 'auth-required']) {
      expect(isResolved(s)).toBe(false);
    }
  });
});

describe('wouldCycle', () => {
  const link = (from: string, to: string, kind: LinkRow['kind'] = 'blocks'): LinkRow => ({
    fromCardId: from, toCardId: to, kind,
  });

  it('catches the direct case', () => {
    expect(wouldCycle([link('a', 'b')], link('b', 'a'))).toBe(true);
  });

  it('catches a long chain', () => {
    expect(wouldCycle([link('a', 'b'), link('b', 'c'), link('c', 'd')], link('d', 'a'))).toBe(true);
  });

  it('catches a self-link', () => {
    expect(wouldCycle([], link('a', 'a'))).toBe(true);
  });

  it('allows a diamond, which is not a cycle', () => {
    expect(wouldCycle([link('a', 'b'), link('a', 'c'), link('b', 'd')], link('c', 'd'))).toBe(false);
  });

  it('ignores `relates`, which orders nothing', () => {
    expect(wouldCycle([link('a', 'b', 'relates')], link('b', 'a', 'relates'))).toBe(false);
  });

  it('sees blocks and parent as one graph — mixing them can still deadlock', () => {
    expect(wouldCycle([link('a', 'b', 'parent')], link('b', 'a', 'blocks'))).toBe(true);
  });

  it('terminates on an existing cycle instead of hanging', () => {
    expect(wouldCycle([link('a', 'b'), link('b', 'a')], link('c', 'd'))).toBe(false);
  });
});

// ----- BoardDO: card_links storage and addLink/removeLink/listLinks -----

const PIPELINE: BoardInit['stages'] = [
  { key: 'backlog', name: 'Backlog', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function two(board: BoardDO, name: string) {
  await board.init({ id: `brd_${name}`, tenantId: 'tnt_a', name, stages: PIPELINE });
  const a = await board.createCard({ title: 'A', ownerUserId: 'usr_a' });
  const b = await board.createCard({ title: 'B', ownerUserId: 'usr_a' });
  if (!a.ok || !b.ok) throw new Error('setup failed');
  return { a: a.value, b: b.value };
}

describe('BoardDO — card_links', () => {
  it('adds a link and lists it from either side', async () => {
    await runInDurableObject(stubFor('link-add'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'linkadd');
      const added = await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      expect(added.value).toMatchObject({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });

      expect(await board.listLinks(a.id)).toHaveLength(1);
      expect(await board.listLinks(b.id)).toHaveLength(1);
    });
  });

  it('refuses a link to a card that does not exist', async () => {
    await runInDurableObject(stubFor('link-nocard'), async (board: BoardDO) => {
      const { a } = await two(board, 'linknocard');
      const res = await board.addLink({ fromCardId: a.id, toCardId: 'crd_missing', kind: 'blocks' });
      expect(res).toMatchObject({ ok: false, code: 'NO_SUCH_CARD' });
    });
  });

  it('refuses a link that would cycle', async () => {
    await runInDurableObject(stubFor('link-cycle'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'linkcycle');
      const first = await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      expect(first.ok).toBe(true);
      const res = await board.addLink({ fromCardId: b.id, toCardId: a.id, kind: 'blocks' });
      expect(res).toMatchObject({ ok: false, code: 'LINK_WOULD_CYCLE' });
    });
  });

  it('refuses a second parent', async () => {
    await runInDurableObject(stubFor('link-parent'), async (board: BoardDO) => {
      await board.init({ id: 'brd_linkparent', tenantId: 'tnt_a', name: 'LP', stages: PIPELINE });
      const a = await board.createCard({ title: 'Parent A', ownerUserId: 'usr_a' });
      const b = await board.createCard({ title: 'Parent B', ownerUserId: 'usr_a' });
      const c = await board.createCard({ title: 'Child', ownerUserId: 'usr_a' });
      if (!a.ok || !b.ok || !c.ok) throw new Error('setup failed');

      const first = await board.addLink({ fromCardId: a.value.id, toCardId: c.value.id, kind: 'parent' });
      expect(first.ok).toBe(true);
      const second = await board.addLink({ fromCardId: b.value.id, toCardId: c.value.id, kind: 'parent' });
      expect(second).toMatchObject({ ok: false, code: 'ALREADY_HAS_PARENT' });
    });
  });

  it('removes a link', async () => {
    await runInDurableObject(stubFor('link-remove'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'linkremove');
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      const removed = await board.removeLink(a.id, b.id, 'blocks');
      expect(removed.ok).toBe(true);
      expect(await board.listLinks(a.id)).toEqual([]);
      expect(await board.listLinks(b.id)).toEqual([]);
    });
  });

  it('takes a card’s links with it when the card is deleted', async () => {
    await runInDurableObject(stubFor('link-delete'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'linkdelete');
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      await board.deleteCard(a.id);
      expect(await board.listLinks(b.id)).toEqual([]);
      // And b is claimable again, rather than blocked forever by a card that is gone.
      expect((await board.claim({ agentId: 'agt_w', capabilities: ['writing'] })).claimed).toBe(true);
    });
  });
});
