import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const PIPE: BoardInit['stages'] = [{ key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' }];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

describe('BoardDO — settings (rename + GitHub config in the snapshot)', () => {
  it('renames the board', async () => {
    await runInDurableObject(stubFor('set-1'), async (board: BoardDO) => {
      await board.init({ id: 'brd_s', tenantId: 'tnt_a', name: 'Old name', stages: PIPE });
      expect((await board.getState()).name).toBe('Old name');
      const r = await board.setName('New name');
      expect(r.ok).toBe(true);
      expect((await board.getState()).name).toBe('New name');
    });
  });

  it('exposes the GitHub config (issue trigger + whether a webhook secret is set) in the snapshot', async () => {
    await runInDurableObject(stubFor('set-2'), async (board: BoardDO) => {
      await board.init({ id: 'brd_g', tenantId: 'tnt_a', name: 'G', stages: PIPE });
      expect((await board.getState()).github).toEqual({ issueTrigger: false, webhookConfigured: false, triggerGrantCount: null });

      await board.setGithubConfig({ issueTrigger: true, secret: 's3cr3t' });
      expect((await board.getState()).github).toEqual({ issueTrigger: true, webhookConfigured: true, triggerGrantCount: null });
    });
  });
});
