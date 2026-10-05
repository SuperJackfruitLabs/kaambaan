import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { reportingEnabled, reporterConfig } from '../src/superwitness/config';
import { runRow, withReporting } from './helpers/superwitness';

const BUILD: BoardInit['stages'] = [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function claimOne(board: BoardDO, boardId: string): Promise<string> {
  await board.init({ id: boardId, tenantId: 'tnt_sw', name: 'Release board', stages: BUILD });
  await board.createCard({ title: 'Build it', ownerUserId: 'usr_a' });
  const c = await board.claim({ agentId: 'agt_w', capabilities: ['build'] });
  if (!c.claimed) throw new Error('expected a claim');
  return c.runId;
}

describe('superwitness outbox — configuration', () => {
  it('reporting is on only when SUPERWITNESS_URL is set', () => {
    expect(reportingEnabled({})).toBe(false);
    expect(reportingEnabled({ SUPERWITNESS_URL: '  ' })).toBe(false);
    expect(reportingEnabled({ SUPERWITNESS_URL: 'https://sw.test' })).toBe(true);
  });

  it('reporterConfig names what is missing', () => {
    const ok = { SUPERWITNESS_URL: 'https://sw.test', HUB_ISSUER: 'https://hub.test', SUPERWITNESS_REPORTER_CREDENTIAL: 'svc_a:b' };
    expect(reporterConfig(ok)).toEqual({
      runsUrl: 'https://sw.test/v1/runs',
      tokenUrl: 'https://hub.test/api/auth/service-token',
      credential: 'svc_a:b',
    });
    expect(reporterConfig({ ...ok, SUPERWITNESS_URL: 'http://sw.test' })).toEqual({ error: 'superwitness_url_invalid' });
    expect(reporterConfig({ ...ok, HUB_ISSUER: undefined })).toEqual({ error: 'hub_issuer_missing' });
    expect(reporterConfig({ ...ok, SUPERWITNESS_REPORTER_CREDENTIAL: 'no-colon' })).toEqual({ error: 'credential_missing' });
    expect(reporterConfig({ ...ok, SUPERWITNESS_REPORTER_CREDENTIAL: 'svc_a:' })).toEqual({ error: 'credential_missing' });
  });
});

describe('superwitness outbox — the claim site', () => {
  it('writes nothing to the outbox when SUPERWITNESS_URL is unset, but still stamps updated_at', async () => {
    await withReporting(async () => {
      await runInDurableObject(stubFor('swo-off'), async (board: BoardDO, state) => {
        const runId = await claimOne(board, 'brd_swo_off');
        expect(await board.getRunReportOutbox()).toEqual([]);
        expect(runRow(state, runId).updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });
    }, {});
  });

  it('enqueues a running report in the same span as the claim', async () => {
    await withReporting(async () => {
      await runInDurableObject(stubFor('swo-claim'), async (board: BoardDO, state) => {
        const runId = await claimOne(board, 'brd_swo_claim');
        const rows = await board.getRunReportOutbox();
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row).toMatchObject({ runId, gen: 1, status: 'pending', attempts: 0, lastError: null });
        expect(row.reportedAt).toBe(runRow(state, runId).updated_at);
        expect(row.draft).toEqual({
          boardId: 'brd_swo_claim',
          boardName: 'Release board',
          runId,
          agentId: 'agt_w',
          title: 'Build it',
          status: 'running',
          sourceStatus: 'working',
          startedAt: runRow(state, runId).started_at,
          endedAt: null,
          reportedAt: row.reportedAt,
        });
        expect(row.nextAttemptAt).toBeLessThanOrEqual(Date.now());
      });
    });
  });

  it('keeps updated_at strictly increasing even inside one millisecond, and one row per run', async () => {
    await withReporting(async () => {
      await runInDurableObject(stubFor('swo-mono'), async (board: BoardDO, state) => {
        const runId = await claimOne(board, 'brd_swo_mono');
        const first = runRow(state, runId).updated_at as string;
        const internals = board as unknown as { reportRun(id: string): void };
        // Date.now() does not advance inside synchronous code, so these two share a millisecond.
        internals.reportRun(runId);
        const second = runRow(state, runId).updated_at as string;
        internals.reportRun(runId);
        const third = runRow(state, runId).updated_at as string;
        expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
        expect(Date.parse(third) - Date.parse(second)).toBe(1);
        const rows = await board.getRunReportOutbox();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.gen).toBe(3);
        expect(rows[0]!.reportedAt).toBe(third);
      });
    });
  });

  it('destroy empties the outbox', async () => {
    await withReporting(async () => {
      await runInDurableObject(stubFor('swo-destroy'), async (board: BoardDO) => {
        await claimOne(board, 'brd_swo_destroy');
        await board.destroy();
        expect(await board.getRunReportOutbox()).toEqual([]);
      });
    });
  });
});
