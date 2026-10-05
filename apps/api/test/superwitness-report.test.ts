import { describe, it, expect } from 'vitest';
import { buildRunReport, clip, mapRunStatus, type RunFacts, type RunReportDraft } from '../src/superwitness/report';
import { RUN_REPORT_SCHEMA_RAW, RUN_REPORT_SCHEMA_SHA256, sha256Hex, validateRunReportBody } from './helpers/run-report-schema';

const DRAFT: RunReportDraft = {
  boardId: 'brd_x',
  boardName: 'Release board',
  runId: 'run_y',
  agentId: 'agt_w',
  title: 'Draft the release note',
  status: 'running',
  sourceStatus: 'working',
  startedAt: '2026-10-06T10:00:00.000Z',
  endedAt: null,
  reportedAt: '2026-10-06T10:00:00.001Z',
};
const PRN = 'prn_0123456789abcdef0123';

describe('the vendored run-report schema', () => {
  it('is the pinned copy of superwitness’s file', async () => {
    expect(await sha256Hex(RUN_REPORT_SCHEMA_RAW)).toBe(RUN_REPORT_SCHEMA_SHA256);
  });

  it('accepts a built report, alone and in a batch of 100', () => {
    const one = buildRunReport(DRAFT, { principalId: PRN, name: 'Writer' });
    expect(validateRunReportBody(one)).toEqual({ valid: true, errors: [] });
    expect(validateRunReportBody({ runs: Array.from({ length: 100 }, () => one) }).valid).toBe(true);
  });

  // Guards on the guard: if the validator ignored formats, limits or additionalProperties, every
  // contract test downstream would pass for the wrong reason.
  it.each([
    ['101 items', { runs: Array.from({ length: 101 }, () => buildRunReport(DRAFT, { principalId: null, name: 'w' })) }],
    ['an empty batch', { runs: [] }],
    ['an unknown field', { ...buildRunReport(DRAFT, { principalId: null, name: 'w' }), extra: 1 }],
    ['an unknown status', { ...buildRunReport(DRAFT, { principalId: null, name: 'w' }), status: 'paused' }],
    ['a non-timestamp reported_at', { ...buildRunReport(DRAFT, { principalId: null, name: 'w' }), reported_at: 'yesterday' }],
    ['a 201-character title', { ...buildRunReport(DRAFT, { principalId: null, name: 'w' }), title: 'x'.repeat(201) }],
    ['a non-principal executor id', { ...buildRunReport(DRAFT, { principalId: null, name: 'w' }), executor: { id: 'agt_w', name: 'w' } }],
    ['a null title', { ...buildRunReport(DRAFT, { principalId: null, name: 'w' }), title: null }],
  ])('rejects %s', (_name, body) => {
    expect(validateRunReportBody(body).valid).toBe(false);
  });
});

describe('mapRunStatus — the table in the plan', () => {
  const g = (status: string, decision: string | null = null) => ({ status, decision });
  const cases: Array<[RunFacts, string, string]> = [
    [{ status: 'working', outcome: null, pendingElicitation: false, gate: null }, 'running', 'working'],
    [{ status: 'working', outcome: null, pendingElicitation: true, gate: null }, 'waiting', 'working'],
    [{ status: 'ended', outcome: 'completed', pendingElicitation: false, gate: null }, 'succeeded', 'completed'],
    [{ status: 'ended', outcome: 'completed', pendingElicitation: false, gate: g('pending') }, 'waiting', 'completed'],
    [{ status: 'ended', outcome: 'submitted', pendingElicitation: false, gate: g('pending') }, 'waiting', 'submitted'],
    [{ status: 'ended', outcome: 'submitted', pendingElicitation: false, gate: g('resolved', 'approve') }, 'succeeded', 'submitted'],
    [{ status: 'ended', outcome: 'completed', pendingElicitation: false, gate: g('resolved', 'approve') }, 'succeeded', 'completed'],
    [{ status: 'ended', outcome: 'submitted', pendingElicitation: false, gate: g('resolved', 'request_changes') }, 'failed', 'submitted'],
    [{ status: 'ended', outcome: 'submitted', pendingElicitation: false, gate: g('resolved', 'reject') }, 'failed', 'submitted'],
    [{ status: 'ended', outcome: 'completed', pendingElicitation: false, gate: g('cancelled') }, 'cancelled', 'completed'],
    [{ status: 'ended', outcome: 'submitted', pendingElicitation: false, gate: null }, 'waiting', 'submitted'],
    [{ status: 'ended', outcome: 'blocked', pendingElicitation: false, gate: g('pending') }, 'failed', 'blocked'],
    [{ status: 'ended', outcome: 'crashed', pendingElicitation: false, gate: null }, 'failed', 'crashed'],
    [{ status: 'ended', outcome: 'reclaimed', pendingElicitation: false, gate: null }, 'failed', 'reclaimed'],
    [{ status: 'ended', outcome: 'released', pendingElicitation: false, gate: null }, 'cancelled', 'released'],
    [{ status: 'ended', outcome: 'vanished', pendingElicitation: false, gate: null }, 'failed', 'vanished'],
  ];
  it.each(cases)('%j → %s / %s', (facts, status, sourceStatus) => {
    expect(mapRunStatus(facts)).toEqual({ status, sourceStatus });
  });

  it('never produces queued (R1)', () => {
    for (const [facts] of cases) expect(mapRunStatus(facts).status).not.toBe('queued');
  });
});

describe('buildRunReport', () => {
  it('produces exactly the spec §3.2 fields, in order', () => {
    const r = buildRunReport(DRAFT, { principalId: PRN, name: 'Writer' });
    expect(Object.keys(r)).toEqual([
      'source', 'external_ref', 'scope', 'title', 'executor', 'status', 'source_status', 'started_at', 'ended_at', 'reported_at',
    ]);
    expect(r).toEqual({
      source: 'superpipeline',
      external_ref: 'brd_x/run_y',
      scope: { id: 'brd_x', name: 'Release board' },
      title: 'Draft the release note',
      executor: { id: PRN, name: 'Writer' },
      status: 'running',
      source_status: 'working',
      started_at: '2026-10-06T10:00:00.000Z',
      ended_at: null,
      reported_at: '2026-10-06T10:00:00.001Z',
    });
  });

  it('clips multibyte text by code points and stays valid', () => {
    const long = '𝔁'.repeat(250);
    const r = buildRunReport({ ...DRAFT, title: long, boardName: long }, { principalId: null, name: long });
    expect(Array.from(r.title!)).toHaveLength(200);
    expect(Array.from(r.scope.name!)).toHaveLength(200);
    expect(Array.from(r.executor.name)).toHaveLength(200);
    expect(validateRunReportBody(r).valid).toBe(true);
  });

  it('omits a blank title and a missing board name rather than sending empty strings', () => {
    const r = buildRunReport({ ...DRAFT, title: '   ', boardName: null }, { principalId: null, name: 'w' });
    expect('title' in r).toBe(false);
    expect(r.scope).toEqual({ id: 'brd_x' });
    expect(validateRunReportBody(r).valid).toBe(true);
  });

  it('omits an executor id that is not a principal, and names the agent by its local id when the catalog has no name', () => {
    expect(buildRunReport(DRAFT, { principalId: 'usr_x', name: null }).executor).toEqual({ name: 'agt_w' });
  });

  it('clip trims and counts code points', () => {
    expect(clip('  ab  ', 5)).toBe('ab');
    expect(clip(null, 5)).toBe('');
    expect(clip('😀😀😀', 2)).toBe('😀😀');
  });
});
