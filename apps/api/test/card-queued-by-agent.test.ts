import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const PIPE: BoardInit['stages'] = [
  { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
  { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'code' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

/**
 * A card has to remember that an AGENT asked for it.
 *
 * `queued_by` alone cannot carry this. It holds one principal id and is overwritten by whoever
 * re-queues the card, and nothing about a `prn_…` says whether a person or a coordinator wrote it.
 * Without a separate field the audit trail credits the operator with work they never requested.
 */
describe('BoardDO — a card records the agent that queued it', () => {
  it('defaults to null, so every card that exists today reads as human-queued', async () => {
    await runInDurableObject(stubFor('qba-1'), async (board: BoardDO) => {
      await board.init({ id: 'brd_q1', tenantId: 'tnt_a', name: 'Q', stages: PIPE });
      const c = await board.createCard({ title: 'Asked for by a person', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');
      expect(c.value.queuedByAgentId).toBeNull();
      expect(c.value.queuedBy).toBe('usr_a');
    });
  });

  it('records the agent, and separates WHO AUTHORISED from WHO IS ANSWERABLE', async () => {
    await runInDurableObject(stubFor('qba-2'), async (board: BoardDO) => {
      await board.init({ id: 'brd_q2', tenantId: 'tnt_a', name: 'Q', stages: PIPE });
      const c = await board.createCard({
        title: 'Shaped by the coordinator',
        // The human who owns the agent is answerable for the card...
        ownerUserId: 'usr_rakesh',
        // ...the agent's principal is the authority the control pair checks...
        queuedBy: 'prn_chotu',
        // ...and the local row is what the UI can turn into a name and an avatar.
        queuedByAgentId: 'agt_chotu',
        queuedGrant: ['prn_kai', 'prn_tim'],
      });
      if (!c.ok) throw new Error('card');
      expect(c.value.ownerUserId).toBe('usr_rakesh');
      expect(c.value.queuedBy).toBe('prn_chotu');
      expect(c.value.queuedByAgentId).toBe('agt_chotu');
      expect(c.value.queuedGrant).toEqual(['prn_kai', 'prn_tim']);

      // And it survives the trip through the snapshot the board renders from — a field the DO
      // stores but `snapshot()` drops is the defect this estate has hit eight times.
      const snap = await board.getState();
      expect(snap.cards.find((x) => x.id === c.value.id)?.queuedByAgentId).toBe('agt_chotu');
    });
  });

  it('A HUMAN RE-QUEUEING CLEARS IT: the tile must stop crediting the agent', async () => {
    // Without this, moving an agent-queued card into another stage leaves `queued_by_agent_id`
    // standing while `queued_by` becomes the mover — so the card would read "queued by Super
    // Chotu" about a dispatch the operator personally authorised. The pair has to move together.
    await runInDurableObject(stubFor('qba-3'), async (board: BoardDO) => {
      await board.init({ id: 'brd_q3', tenantId: 'tnt_a', name: 'Q', stages: PIPE });
      const c = await board.createCard({
        title: 'Taken over',
        ownerUserId: 'usr_rakesh',
        queuedBy: 'prn_chotu',
        queuedByAgentId: 'agt_chotu',
      });
      if (!c.ok) throw new Error('card');

      const moved = await board.moveCard(c.value.id, 'build', 'usr_rakesh', ['prn_kai']);
      if (!moved.ok) throw new Error('move failed');
      expect(moved.value.queuedBy).toBe('usr_rakesh');
      expect(moved.value.queuedByAgentId).toBeNull();
    });
  });

  it('an INTERNAL move leaves the whole pair standing', async () => {
    // `moveCard` with no actor already COALESCEs `queued_by` rather than blanking it, because an
    // automatic move dispatches nothing new. The agent id has to follow the same rule or an
    // internal advance would silently rewrite the card's authorship to "a person".
    await runInDurableObject(stubFor('qba-4'), async (board: BoardDO) => {
      await board.init({ id: 'brd_q4', tenantId: 'tnt_a', name: 'Q', stages: PIPE });
      const c = await board.createCard({
        title: 'Advanced by the machine',
        ownerUserId: 'usr_rakesh',
        queuedBy: 'prn_chotu',
        queuedByAgentId: 'agt_chotu',
      });
      if (!c.ok) throw new Error('card');

      const moved = await board.moveCard(c.value.id, 'build');
      if (!moved.ok) throw new Error('move failed');
      expect(moved.value.queuedBy).toBe('prn_chotu');
      expect(moved.value.queuedByAgentId).toBe('agt_chotu');
    });
  });

  it('a child inherits it, because a split of agent-queued work is agent-queued', async () => {
    // `createChildCard` already inherits `queuedGrant` non-optionally: a child created with a null
    // grant was unclaimable under enforcement. Authorship follows the same logic — a sub-task of
    // a card Chotu asked for was not asked for by a person.
    await runInDurableObject(stubFor('qba-5'), async (board: BoardDO) => {
      await board.init({ id: 'brd_q5', tenantId: 'tnt_a', name: 'Q', stages: PIPE });
      const parent = await board.createCard({
        title: 'Parent',
        ownerUserId: 'usr_rakesh',
        queuedBy: 'prn_chotu',
        queuedByAgentId: 'agt_chotu',
        queuedGrant: ['prn_kai'],
      });
      if (!parent.ok) throw new Error('parent');

      const child = await board.createChildCard(parent.value.id, { title: 'Piece one', ownerUserId: 'usr_rakesh' });
      if (!child.ok) throw new Error('child');
      expect(child.value.queuedByAgentId).toBe('agt_chotu');
      expect(child.value.queuedGrant).toEqual(['prn_kai']);
    });
  });
});
