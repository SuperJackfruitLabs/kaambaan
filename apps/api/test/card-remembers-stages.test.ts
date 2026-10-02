import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { resolveReferenceInput } from '../src/references/resolve';

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

const PIPE: BoardInit['stages'] = [
  { key: 'audit', name: 'Audit', order: 0, ownerKind: 'capability', owner: 'ux' },
  { key: 'measure', name: 'Measure', order: 1, ownerKind: 'capability', owner: 'performance' },
  { key: 'done', name: 'Done', order: 2, ownerKind: 'human', gate: 'approval' },
];

async function claim(board: BoardDO, caps: string[], agentId = 'agt_w') {
  const run = await board.claim({ agentId, capabilities: caps });
  if (!run.claimed) throw new Error('expected a claim');
  return run;
}

/**
 * A run ends and takes its output with it — three times over.
 *
 * `fail()` stored a LABEL (`outcome = 'crashed'`) and sent the reason to a human's notification and
 * the event stream, never to the agent about to repeat the work. `complete()` wrote the handoff onto
 * the CARD, so each stage overwrote the last. And `card_references` had no run column, so what a
 * stage attached was unanswerable even though every reference was still there.
 */
describe('a retry is TOLD why the last attempt failed', () => {
  it('delivers the reason, the agent and the stage to the next claim', async () => {
    await runInDurableObject(stubFor('rem-1'), async (board: BoardDO) => {
      await board.init({ id: 'brd_r1', tenantId: 'tnt_a', name: 'R', stages: PIPE });
      const c = await board.createCard({ title: 'Audit me', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');

      const first = await claim(board, ['ux'], 'agt_ulrich');
      // A first claim has nothing to report — and that is the common case, so it must stay the
      // cheap one.
      expect(first.lastFailure).toBeNull();

      await board.fail({
        runId: first.runId,
        leaseEpoch: first.leaseEpoch,
        reason: 'The local browser could not be started: Chrome exited early',
      });

      const second = await claim(board, ['ux'], 'agt_ulrich');
      expect(second.lastFailure?.reason).toContain('Chrome exited early');
      expect(second.lastFailure?.agentId).toBe('agt_ulrich');
      expect(second.lastFailure?.stageKey).toBe('audit');
      expect(second.lastFailure?.endedAt).toBeTruthy();
    });
  });

  it('does NOT carry a failure across stages', async () => {
    // A failure at `audit` tells an agent claiming `audit` something. It tells an agent claiming
    // `measure` almost nothing, and handing it over would read as "your work has already failed
    // once" about work that has not started.
    await runInDurableObject(stubFor('rem-2'), async (board: BoardDO) => {
      await board.init({ id: 'brd_r2', tenantId: 'tnt_a', name: 'R', stages: PIPE });
      const c = await board.createCard({ title: 'Two stages', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');

      const a = await claim(board, ['ux']);
      await board.fail({ runId: a.runId, leaseEpoch: a.leaseEpoch, reason: 'audit blew up' });
      const b = await claim(board, ['ux']);
      expect(b.lastFailure?.reason).toBe('audit blew up');
      await board.complete({ runId: b.runId, leaseEpoch: b.leaseEpoch, handoff: { summary: 'audited' } });

      // Now at `measure`, with a clean slate.
      const m = await claim(board, ['performance']);
      expect(m.stage.key).toBe('measure');
      expect(m.lastFailure).toBeNull();
    });
  });

  it('does not resurrect a failure after a run has since succeeded at that stage', async () => {
    // "The last attempt failed" must mean the LAST one. Reporting an older failure after a success
    // would have an agent working around a problem that is already solved.
    await runInDurableObject(stubFor('rem-3'), async (board: BoardDO) => {
      await board.init({ id: 'brd_r3', tenantId: 'tnt_a', name: 'R', stages: PIPE });
      const c = await board.createCard({ title: 'Recovered', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');

      const a = await claim(board, ['ux']);
      await board.fail({ runId: a.runId, leaseEpoch: a.leaseEpoch, reason: 'transient' });
      const b = await claim(board, ['ux']);
      expect(b.lastFailure).not.toBeNull();
      await board.complete({ runId: b.runId, leaseEpoch: b.leaseEpoch, handoff: { summary: 'ok' } });
      // Send it back to audit and claim again: the last run at this stage SUCCEEDED.
      await board.moveCard(c.value.id, 'audit', 'usr_a');
      const third = await claim(board, ['ux']);
      expect(third.lastFailure).toBeNull();
    });
  });
});

describe("each stage's handoff is kept", () => {
  it('survives the next stage completing — the regression one column caused', async () => {
    await runInDurableObject(stubFor('rem-4'), async (board: BoardDO) => {
      await board.init({ id: 'brd_r4', tenantId: 'tnt_a', name: 'R', stages: PIPE });
      const c = await board.createCard({ title: 'Two handoffs', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');

      const a = await claim(board, ['ux'], 'agt_ulrich');
      await board.complete({ runId: a.runId, leaseEpoch: a.leaseEpoch, handoff: { summary: 'audit found three issues' } });
      const m = await claim(board, ['performance'], 'agt_pete');
      await board.complete({ runId: m.runId, leaseEpoch: m.leaseEpoch, handoff: { summary: 'measured, p95 is 4.1s' } });

      const attempts = await board.getAttempts(c.value.id);
      expect(attempts).toHaveLength(2);
      // The card carries only the LAST handoff — unchanged, because that is what the next claim
      // reads. The per-stage record is on the runs.
      expect(attempts[0]!.stageKey).toBe('audit');
      expect(JSON.stringify(attempts[0]!.handoff)).toContain('three issues');
      expect(attempts[1]!.stageKey).toBe('measure');
      expect(JSON.stringify(attempts[1]!.handoff)).toContain('p95');
    });
  });

  it('records the failure reason on the attempt, so the UI can show how a run ended', async () => {
    await runInDurableObject(stubFor('rem-5'), async (board: BoardDO) => {
      await board.init({ id: 'brd_r5', tenantId: 'tnt_a', name: 'R', stages: PIPE });
      const c = await board.createCard({ title: 'Ended badly', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');
      const a = await claim(board, ['ux']);
      await board.fail({ runId: a.runId, leaseEpoch: a.leaseEpoch, reason: 'chromium is a snap stub' });

      const attempts = await board.getAttempts(c.value.id);
      expect(attempts[0]!.failureReason).toBe('chromium is a snap stub');
      expect(attempts[0]!.handoff).toBeNull();
    });
  });
});

describe('a reference knows which run attached it', () => {
  it('records the run for an agent, and null for a human', async () => {
    await runInDurableObject(stubFor('rem-6'), async (board: BoardDO) => {
      await board.init({ id: 'brd_r6', tenantId: 'tnt_a', name: 'R', stages: PIPE });
      const c = await board.createCard({ title: 'With evidence', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');
      const a = await claim(board, ['ux']);

      const byAgent = await board.addReference(
        resolveReferenceInput({ cardId: c.value.id, url: 'https://x.y/evidence', addedBy: 'agent', runId: a.runId }),
      );
      if (!byAgent.ok) throw new Error('agent ref');
      expect(byAgent.value.runId).toBe(a.runId);

      // A human attaches no run, and NULL is the honest value rather than a fabricated one.
      const byHuman = await board.addReference(
        resolveReferenceInput({ cardId: c.value.id, url: 'https://x.y/by-a-person', addedBy: 'user' }),
      );
      if (!byHuman.ok) throw new Error('human ref');
      expect(byHuman.value.runId).toBeNull();
    });
  });
});

describe('a card from before this change', () => {
  it('claims, renders and completes with every new field null', async () => {
    // The migration is three guarded ALTERs, so an existing card simply has NULLs. The UI must say
    // nothing rather than something false, and the claim path must not depend on any of them.
    await runInDurableObject(stubFor('rem-7'), async (board: BoardDO) => {
      await board.init({ id: 'brd_r7', tenantId: 'tnt_a', name: 'R', stages: PIPE });
      const c = await board.createCard({ title: 'Legacy', ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error('card');
      const a = await claim(board, ['ux']);
      expect(a.lastFailure).toBeNull();
      await board.complete({ runId: a.runId, leaseEpoch: a.leaseEpoch, handoff: null });
      const attempts = await board.getAttempts(c.value.id);
      expect(attempts[0]!.handoff).toBeNull();
      expect(attempts[0]!.failureReason).toBeNull();
    });
  });
});
