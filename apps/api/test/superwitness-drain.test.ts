import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { createAgent, setAgentExternalMapping } from '../src/db/catalog';
import { fakeSuperwitness, withReporting, REPORTING_ON, trackBoard, quietBoards } from './helpers/superwitness';
import { validateRunReportBody } from './helpers/run-report-schema';

const TENANT = 'tnt_swd';
const BUILD: BoardInit['stages'] = [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build', gate: 'approval' }];
const SECRET_TITLE = 'Quarterly secret plan 7f3a';
const SECRET_BOARD = 'Board secret 9c1e';

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return trackBoard(env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>);
}

/** n claimed runs on one board, one card each. */
async function runs(board: BoardDO, boardId: string, n: number, agentId = 'agt_w') {
  await board.init({ id: boardId, tenantId: TENANT, name: SECRET_BOARD, stages: BUILD });
  const out: Array<{ runId: string; leaseEpoch: number }> = [];
  for (let i = 0; i < n; i++) {
    await board.createCard({ title: SECRET_TITLE, ownerUserId: 'usr_a' });
    const c = await board.claim({ agentId, capabilities: ['build'], maxConcurrency: 1000 });
    if (!c.claimed) throw new Error('expected a claim');
    out.push({ runId: c.runId, leaseEpoch: c.leaseEpoch });
  }
  return out;
}

afterEach(() => vi.restoreAllMocks());
afterEach(quietBoards);

describe('drainRunReports', () => {
  it('sends schema-valid batches for every status, resolves the executor, and empties the outbox', () =>
    withReporting(() =>
      runInDurableObject(stubFor('swd-contract'), async (board: BoardDO, state) => {
        const agent = await createAgent(env.DB, TENANT, { name: 'Writer', capabilities: ['build'] });
        await setAgentExternalMapping(env.DB, TENANT, agent.id, { externalId: 'prn_0123456789abcdef0123', externalSource: 'org-plane' });
        const [a, b, c, d, e] = await runs(board, 'brd_swd_contract', 5, agent.id);
        await state.storage.deleteAlarm();
        await board.postActivity({ runId: a!.runId, leaseEpoch: a!.leaseEpoch, type: 'elicitation', body: 'Which?' }); // waiting
        await board.submitForReview({ runId: b!.runId, leaseEpoch: b!.leaseEpoch });
        const gateId = state.storage.sql.exec(`SELECT id FROM gates WHERE run_id = ?`, b!.runId).one().id as string;
        await board.resolveGate({ gateId, decision: 'approve', decidedBy: 'usr_h' }); // succeeded
        await board.fail({ runId: c!.runId, leaseEpoch: c!.leaseEpoch, reason: 'x' }); // failed
        await board.release({ runId: d!.runId, leaseEpoch: d!.leaseEpoch }); // cancelled
        void e; // running

        const sw = fakeSuperwitness();
        expect(await board.drainRunReports({ fetcher: sw.fetcher })).toEqual({ sent: 5, retried: 0, parked: 0 });
        expect(sw.batches).toHaveLength(1);
        expect(validateRunReportBody(JSON.parse(sw.batches[0]!.raw))).toEqual({ valid: true, errors: [] });
        const statuses = sw.batches[0]!.body.runs.map((r) => r.status).sort();
        expect(statuses).toEqual(['cancelled', 'failed', 'running', 'succeeded', 'waiting']);
        expect(sw.batches[0]!.body.runs[0]!.executor).toEqual({ id: 'prn_0123456789abcdef0123', name: 'Writer' });
        expect(sw.batches[0]!.body.runs[0]!.scope).toEqual({ id: 'brd_swd_contract', name: SECRET_BOARD });
        expect(await board.getRunReportOutbox()).toEqual([]);
      }),
    ));

  it('does nothing when reporting is off', () =>
    withReporting(async () => {
      await runInDurableObject(stubFor('swd-off'), async (board: BoardDO, state) => {
        await withReporting(() => runs(board, 'brd_swd_off', 1)); // rows written while on
        const sw = fakeSuperwitness();
        expect(await board.drainRunReports({ fetcher: sw.fetcher })).toEqual({ sent: 0, retried: 0, parked: 0 });
        expect(sw.batches).toHaveLength(0);
        expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM run_reports`).one().n).toBe(1);
      });
    }, {}));

  it('keeps a newer snapshot written during the send (gen guard)', () =>
    withReporting(() =>
      runInDurableObject(stubFor('swd-gen'), async (board: BoardDO, state) => {
        const [r] = await runs(board, 'brd_swd_gen', 1);
        await state.storage.deleteAlarm();
        const sw = fakeSuperwitness({
          runs: async (body) => {
            // The run changes while its report is in flight.
            await board.postActivity({ runId: r!.runId, leaseEpoch: r!.leaseEpoch, type: 'elicitation', body: 'Which?' });
            return Response.json({ results: body.runs.map((x) => ({ external_ref: x.external_ref, applied: true })) });
          },
        });
        await board.drainRunReports({ fetcher: sw.fetcher });
        const rows = await board.getRunReportOutbox();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ gen: 2, status: 'pending', attempts: 0 });
        expect(rows[0]!.draft.status).toBe('waiting');
      }),
    ));

  // The retry and park UPDATEs carry the same guard: a failed send must not back off or park a
  // snapshot it never sent.
  it.each([
    ['park (400)', () => Response.json({ error: { code: 'bad_request', message: 'no' } }, { status: 400 })],
    ['retry (503)', () => new Response('down', { status: 503 })],
  ] as const)('keeps a newer snapshot written during a failed send — %s', (name, answer) =>
    withReporting(() =>
      runInDurableObject(stubFor(`swd-gen-${name.slice(0, 5)}`), async (board: BoardDO, state) => {
        const [r] = await runs(board, `brd_swd_gen_${name.slice(0, 5)}`, 1);
        await state.storage.deleteAlarm();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const sw = fakeSuperwitness({
          runs: async () => {
            await board.postActivity({ runId: r!.runId, leaseEpoch: r!.leaseEpoch, type: 'elicitation', body: 'Which?' });
            return answer();
          },
        });
        await board.drainRunReports({ fetcher: sw.fetcher });
        expect(sw.batches).toHaveLength(1);
        const rows = await board.getRunReportOutbox();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ gen: 2, status: 'pending', attempts: 0, lastError: null });
        expect(rows[0]!.draft.status).toBe('waiting');
      }),
    ));

  it('backs off 30 s, then 60 s, and does not send before the row is due', () =>
    withReporting(() =>
      runInDurableObject(stubFor('swd-backoff'), async (board: BoardDO, state) => {
        await runs(board, 'brd_swd_backoff', 1);
        await state.storage.deleteAlarm(); // no self-fired drain ahead of this test's own
        const sw = fakeSuperwitness({ runs: () => new Response('down', { status: 503 }) });
        const t0 = Date.now() + 1;
        expect(await board.drainRunReports({ fetcher: sw.fetcher, nowMs: t0 })).toEqual({ sent: 0, retried: 1, parked: 0 });
        let row = (await board.getRunReportOutbox())[0]!;
        expect(row).toMatchObject({ attempts: 1, nextAttemptAt: t0 + 30_000, lastError: 'http_503', status: 'pending' });
        await board.drainRunReports({ fetcher: sw.fetcher, nowMs: t0 + 29_999 });
        expect(sw.batches).toHaveLength(1);
        await board.drainRunReports({ fetcher: sw.fetcher, nowMs: t0 + 30_000 });
        row = (await board.getRunReportOutbox())[0]!;
        expect(row).toMatchObject({ attempts: 2, nextAttemptAt: t0 + 30_000 + 60_000 });
      }),
    ));

  it('honours Retry-After as a floor on 429', () =>
    withReporting(() =>
      runInDurableObject(stubFor('swd-429'), async (board: BoardDO, state) => {
        await runs(board, 'brd_swd_429', 1);
        await state.storage.deleteAlarm();
        const sw = fakeSuperwitness({ runs: () => new Response('', { status: 429, headers: { 'Retry-After': '600' } }) });
        const t0 = Date.now() + 1;
        await board.drainRunReports({ fetcher: sw.fetcher, nowMs: t0 });
        expect((await board.getRunReportOutbox())[0]!.nextAttemptAt).toBe(t0 + 600_000);
      }),
    ));

  it('parks after the 12th failed attempt and counts it', () =>
    withReporting(() =>
      runInDurableObject(stubFor('swd-giveup'), async (board: BoardDO, state) => {
        await runs(board, 'brd_swd_giveup', 1);
        await state.storage.deleteAlarm();
        state.storage.sql.exec(`UPDATE run_reports SET attempts = 11`);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const sw = fakeSuperwitness({ runs: () => new Response('down', { status: 500 }) });
        expect(await board.drainRunReports({ fetcher: sw.fetcher, nowMs: Date.now() + 1 })).toEqual({ sent: 0, retried: 0, parked: 1 });
        expect((await board.getRunReportOutbox())[0]).toMatchObject({ status: 'dead', attempts: 12 });
        expect(warn.mock.calls.some(([e]) => (e as { metric?: string; value?: number }).metric === 'run_reports_dead' && (e as { value?: number }).value === 1)).toBe(true);
      }),
    ));

  it('parks a 4xx without retrying it, and the next change revives the row', () =>
    withReporting(() =>
      runInDurableObject(stubFor('swd-park'), async (board: BoardDO, state) => {
        const [r] = await runs(board, 'brd_swd_park', 1);
        await state.storage.deleteAlarm();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const sw = fakeSuperwitness({ runs: () => Response.json({ error: { code: 'bad_request', message: 'Title "' + SECRET_TITLE + '" is not allowed' } }, { status: 400 }) });
        await board.drainRunReports({ fetcher: sw.fetcher });
        expect((await board.getRunReportOutbox())[0]).toMatchObject({ status: 'dead', attempts: 1, lastError: '400 bad_request' });
        await board.drainRunReports({ fetcher: sw.fetcher, nowMs: Date.now() + 7_200_000 });
        expect(sw.batches).toHaveLength(1);
        await board.release({ runId: r!.runId, leaseEpoch: r!.leaseEpoch });
        expect((await board.getRunReportOutbox())[0]).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
      }),
    ));

  it('a 422 naming one item parks only that item and sends the rest', () =>
    withReporting(() =>
      runInDurableObject(stubFor('swd-422'), async (board: BoardDO, state) => {
        await runs(board, 'brd_swd_422', 3);
        await state.storage.deleteAlarm();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const sw = fakeSuperwitness({
          runs: (body, n) =>
            n === 1
              ? Response.json({ error: { code: 'invalid_report', message: 'bad item', index: 1 } }, { status: 422 })
              : Response.json({ results: body.runs.map((x) => ({ external_ref: x.external_ref, applied: true })) }),
        });
        const badRef = await (async () => (await board.getRunReportOutbox())[1]!.runId)();
        expect(await board.drainRunReports({ fetcher: sw.fetcher })).toEqual({ sent: 2, retried: 0, parked: 1 });
        expect(sw.batches.map((b) => b.body.runs.length)).toEqual([3, 2]);
        const left = await board.getRunReportOutbox();
        expect(left).toHaveLength(1);
        expect(left[0]).toMatchObject({ runId: badRef, status: 'dead' });
      }),
    ));

  it('caps a batch by bytes as well as by count', () =>
    withReporting(() =>
      runInDurableObject(stubFor('swd-bytes'), async (board: BoardDO, state) => {
        await runs(board, 'brd_swd_bytes', 100);
        await state.storage.deleteAlarm();
        const wide = '𝔁'.repeat(200); // 4 bytes each in UTF-8
        for (const row of await board.getRunReportOutbox()) {
          const draft = { ...row.draft, title: wide, boardName: wide, agentId: wide };
          state.storage.sql.exec(`UPDATE run_reports SET report_json = ? WHERE run_id = ?`, JSON.stringify(draft), row.runId);
        }
        const sw = fakeSuperwitness();
        expect((await board.drainRunReports({ fetcher: sw.fetcher })).sent).toBe(100);
        expect(sw.batches.length).toBeGreaterThan(1);
        for (const b of sw.batches) expect(new TextEncoder().encode(b.raw).length).toBeLessThanOrEqual(200 * 1024);
      }),
    ));

  it('a misconfigured reporter retries with a code and posts nothing', () =>
    withReporting(
      () =>
        runInDurableObject(stubFor('swd-misconf'), async (board: BoardDO, state) => {
          await runs(board, 'brd_swd_misconf', 1);
          await state.storage.deleteAlarm();
          vi.spyOn(console, 'warn').mockImplementation(() => {});
          const sw = fakeSuperwitness();
          expect(await board.drainRunReports({ fetcher: sw.fetcher })).toEqual({ sent: 0, retried: 1, parked: 0 });
          expect(sw.hubCalls()).toBe(0);
          expect((await board.getRunReportOutbox())[0]).toMatchObject({ attempts: 1, lastError: 'credential_missing' });
        }),
      { ...REPORTING_ON, SUPERWITNESS_REPORTER_CREDENTIAL: undefined },
    ));

  it('runs one drain at a time', () =>
    withReporting(() =>
      runInDurableObject(stubFor('swd-single'), async (board: BoardDO, state) => {
        await runs(board, 'brd_swd_single', 1);
        await state.storage.deleteAlarm();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const sw = fakeSuperwitness({
          runs: async (body) => {
            await gate;
            return Response.json({ results: body.runs.map((x) => ({ external_ref: x.external_ref, applied: true })) });
          },
        });
        const first = board.drainRunReports({ fetcher: sw.fetcher });
        const second = board.drainRunReports({ fetcher: sw.fetcher });
        release();
        await Promise.all([first, second]);
        expect(sw.batches).toHaveLength(1);
      }),
    ));

  it('never logs a title, a board name, a token or the credential', () =>
    withReporting(() =>
      runInDurableObject(stubFor('swd-nocontent'), async (board: BoardDO, state) => {
        await runs(board, 'brd_swd_nocontent', 3);
        await state.storage.deleteAlarm();
        const lines: unknown[] = [];
        for (const m of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation((...a) => void lines.push(a));
        await board.drainRunReports({ fetcher: fakeSuperwitness({ runs: () => Response.json({ error: { code: 'bad_request', message: 'Title "' + SECRET_TITLE + '" is not allowed' } }, { status: 400 }) }).fetcher });
        state.storage.sql.exec(`UPDATE run_reports SET status = 'pending', next_attempt_at = 0`);
        await board.drainRunReports({ fetcher: fakeSuperwitness({ runs: () => new Response('', { status: 503 }) }).fetcher });
        state.storage.sql.exec(`UPDATE run_reports SET status = 'pending', next_attempt_at = 0, attempts = 11`);
        await board.drainRunReports({ fetcher: fakeSuperwitness({ runs: () => new Response('', { status: 503 }) }).fetcher });
        const text = JSON.stringify(lines);
        expect(lines.length).toBeGreaterThan(0);
        for (const s of [SECRET_TITLE, SECRET_BOARD, 'tok-1', 's3cret']) expect(text).not.toContain(s);
      }),
    ));
});

describe('the alarm drains the outbox', () => {
  // The alarm's only guard against a tight loop is what scheduleReclaim arms after a drain. A
  // working run keeps a 15-minute reclaim deadline in play, so the report term is what is measured.
  it('does not re-arm the alarm for a parked report', () =>
    withReporting(() =>
      runInDurableObject(stubFor('swd-alarm-parked'), async (board: BoardDO, state) => {
        await runs(board, 'brd_swd_alarm_parked', 1);
        await state.storage.deleteAlarm(); // no self-fired drain between here and the read
        state.storage.sql.exec(`UPDATE run_reports SET attempts = 0, next_attempt_at = 0`);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const sw = fakeSuperwitness({ runs: () => Response.json({ error: { code: 'bad_request', message: 'Title "' + SECRET_TITLE + '" is not allowed' } }, { status: 400 }) });
        expect(await board.drainRunReports({ fetcher: sw.fetcher })).toMatchObject({ parked: 1 });
        await (board as unknown as { scheduleReclaim(): Promise<void> }).scheduleReclaim();
        expect((await state.storage.getAlarm())!).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
      }),
    ));

  it('re-arms no sooner than the backoff after a failed drain', () =>
    withReporting(() =>
      runInDurableObject(stubFor('swd-alarm-backoff'), async (board: BoardDO, state) => {
        await runs(board, 'brd_swd_alarm_backoff', 1);
        await state.storage.deleteAlarm();
        state.storage.sql.exec(`UPDATE run_reports SET attempts = 0, next_attempt_at = 0`);
        const sw = fakeSuperwitness({ runs: () => new Response('down', { status: 503 }) });
        expect(await board.drainRunReports({ fetcher: sw.fetcher, nowMs: Date.now() })).toMatchObject({ retried: 1 });
        await (board as unknown as { scheduleReclaim(): Promise<void> }).scheduleReclaim();
        expect((await state.storage.getAlarm())!).toBeGreaterThanOrEqual(Date.now() + 29_000);
      }),
    ));

  it('arms the alarm for a fresh report and sends it when the alarm runs', async () => {
    const stub = stubFor('swd-alarm');
    const realFetch = globalThis.fetch;
    const sw = fakeSuperwitness();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => sw.fetcher(String(input instanceof Request ? input.url : input), init ?? {})) as typeof fetch;
    try {
      await withReporting(async () => {
        await runInDurableObject(stub, async (board: BoardDO, state) => {
          await runs(board, 'brd_swd_alarm', 1);
          const alarm = await state.storage.getAlarm();
          expect(alarm).not.toBeNull();
          expect(alarm!).toBeLessThanOrEqual(Date.now() + 1000); // not the 15-minute reclaim deadline
        });
        // workerd may already have fired the due alarm on its own, in which case its drain is still in
        // flight and runDurableObjectAlarm reports false; wait for the outbox to empty either way.
        await runDurableObjectAlarm(stub);
        await vi.waitFor(async () => {
          await runInDurableObject(stub, async (board: BoardDO) => expect(await board.getRunReportOutbox()).toEqual([]));
        });
        expect(sw.batches).toHaveLength(1);
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('does not arm for reports while reporting is off', () =>
    runInDurableObject(stubFor('swd-alarm-off'), async (board: BoardDO, state) => {
      await withReporting(() => runs(board, 'brd_swd_alarm_off', 1));
      await (board as unknown as { scheduleReclaim(): Promise<void> }).scheduleReclaim();
      expect((await state.storage.getAlarm())!).toBeGreaterThan(Date.now() + 14 * 60 * 1000); // only the reclaim deadline
    }));
});
