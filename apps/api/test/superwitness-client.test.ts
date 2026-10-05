import { describe, it, expect } from 'vitest';
import { ServiceTokenCache, postRunReports, runReportBackoffMs, RUN_REPORT_MAX_ATTEMPTS } from '../src/superwitness/client';
import type { ReporterConfig } from '../src/superwitness/config';
import { buildRunReport } from '../src/superwitness/report';
import { CREDENTIAL, HUB_URL, SW_URL, fakeSuperwitness } from './helpers/superwitness';

const CFG: ReporterConfig = { runsUrl: `${SW_URL}/v1/runs`, tokenUrl: `${HUB_URL}/api/auth/service-token`, credential: CREDENTIAL };
const T0 = 1_800_000_000_000;
const REPORT = buildRunReport(
  {
    boardId: 'brd_x', boardName: 'B', runId: 'run_1', agentId: 'agt_w', title: 'T', status: 'running',
    sourceStatus: 'working', startedAt: '2026-10-06T10:00:00.000Z', endedAt: null, reportedAt: '2026-10-06T10:00:00.001Z',
  },
  { principalId: null, name: 'w' },
);
const REPORTS = [REPORT, { ...REPORT, external_ref: 'brd_x/run_2' }, { ...REPORT, external_ref: 'brd_x/run_3' }];

describe('ServiceTokenCache', () => {
  it('exchanges the credential exactly as the hub parses it, and never follows a redirect', async () => {
    const sw = fakeSuperwitness();
    const r = await new ServiceTokenCache().get(CFG, sw.fetcher, T0);
    expect(r).toEqual({ ok: true, token: 'tok-1' });
    expect(sw.hubInits[0]!.method).toBe('POST');
    expect(new Headers(sw.hubInits[0]!.headers).get('authorization')).toBe(`Bearer ${CREDENTIAL}`);
    expect(sw.hubInits[0]!.redirect).toBe('manual');
  });

  it('caches until 30 s before expiry', async () => {
    const sw = fakeSuperwitness();
    const cache = new ServiceTokenCache();
    await cache.get(CFG, sw.fetcher, T0);
    await cache.get(CFG, sw.fetcher, T0 + 269_999);
    expect(sw.hubCalls()).toBe(1);
    expect(await cache.get(CFG, sw.fetcher, T0 + 270_000)).toEqual({ ok: true, token: 'tok-2' });
    expect(sw.hubCalls()).toBe(2);
  });

  it('reports a hub refusal with a code and caches nothing', async () => {
    const sw = fakeSuperwitness({ hub: () => Response.json({ error: 'invalid service credential' }, { status: 401 }) });
    const cache = new ServiceTokenCache();
    expect(await cache.get(CFG, sw.fetcher, T0)).toEqual({ ok: false, status: 401, code: 'hub_401' });
    await cache.get(CFG, sw.fetcher, T0);
    expect(sw.hubCalls()).toBe(2);
  });

  it('refuses a malformed hub answer', async () => {
    const sw = fakeSuperwitness({ hub: () => Response.json({ token: '', expiresIn: 300 }) });
    expect(await new ServiceTokenCache().get(CFG, sw.fetcher, T0)).toEqual({ ok: false, status: 200, code: 'hub_bad_response' });
  });
});

describe('postRunReports', () => {
  it('posts {"runs":[...]} with the service token and returns the results', async () => {
    const sw = fakeSuperwitness();
    const out = await postRunReports(CFG, new ServiceTokenCache(), sw.fetcher, T0, REPORTS);
    expect(out).toEqual({ kind: 'ok', results: REPORTS.map((r) => ({ external_ref: r.external_ref, applied: true })) });
    expect(sw.batches[0]!.headers.authorization).toBe('Bearer tok-1');
    expect(sw.batches[0]!.headers['content-type']).toBe('application/json');
    expect(sw.batches[0]!.init.redirect).toBe('manual');
    expect(JSON.parse(sw.batches[0]!.raw)).toEqual({ runs: REPORTS });
  });

  it('401 drops the token and is retryable', async () => {
    const sw = fakeSuperwitness({ runs: (_b, n) => (n === 1 ? Response.json({ error: 'unauthorized' }, { status: 401 }) : Response.json({ results: [] })) });
    const cache = new ServiceTokenCache();
    expect(await postRunReports(CFG, cache, sw.fetcher, T0, REPORTS)).toEqual({ kind: 'retry', status: 401, code: 'unauthorized', retryAfterMs: null });
    await postRunReports(CFG, cache, sw.fetcher, T0, REPORTS);
    expect(sw.hubCalls()).toBe(2);
    expect(sw.batches[1]!.headers.authorization).toBe('Bearer tok-2');
  });

  it('403 drops the token and parks', async () => {
    const sw = fakeSuperwitness({ runs: () => Response.json({ error: 'source_not_allowed' }, { status: 403 }) });
    const cache = new ServiceTokenCache();
    expect(await postRunReports(CFG, cache, sw.fetcher, T0, REPORTS)).toEqual({ kind: 'reject', status: 403, code: 'source_not_allowed', index: null });
    await postRunReports(CFG, cache, sw.fetcher, T0, REPORTS);
    expect(sw.hubCalls()).toBe(2);
  });

  it('429 is retryable with Retry-After in ms', async () => {
    const sw = fakeSuperwitness({ runs: () => new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } }) });
    expect(await postRunReports(CFG, new ServiceTokenCache(), sw.fetcher, T0, REPORTS)).toEqual({ kind: 'retry', status: 429, code: 'http_429', retryAfterMs: 120_000 });
  });

  it('5xx, 3xx and a network error are retryable', async () => {
    const five = fakeSuperwitness({ runs: () => Response.json({ error: 'db_unavailable' }, { status: 503 }) });
    expect(await postRunReports(CFG, new ServiceTokenCache(), five.fetcher, T0, REPORTS)).toEqual({ kind: 'retry', status: 503, code: 'db_unavailable', retryAfterMs: null });
    const three = fakeSuperwitness({ runs: () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test/' } }) });
    expect((await postRunReports(CFG, new ServiceTokenCache(), three.fetcher, T0, REPORTS)).kind).toBe('retry');
    const sw = fakeSuperwitness();
    const broken: typeof sw.fetcher = async (url, init) => {
      if (url.endsWith('/v1/runs')) throw new TypeError('network');
      return sw.fetcher(url, init);
    };
    expect(await postRunReports(CFG, new ServiceTokenCache(), broken, T0, REPORTS)).toEqual({ kind: 'retry', status: 0, code: 'network', retryAfterMs: null });
  });

  it('a hub failure is retryable and nothing is posted', async () => {
    const sw = fakeSuperwitness({ hub: () => new Response('down', { status: 502 }) });
    expect(await postRunReports(CFG, new ServiceTokenCache(), sw.fetcher, T0, REPORTS)).toEqual({ kind: 'retry', status: 502, code: 'hub_502', retryAfterMs: null });
    expect(sw.batches).toHaveLength(0);
  });

  it('422 names the bad item by index; an unusable index parks the batch', async () => {
    const named = fakeSuperwitness({ runs: () => Response.json({ error: 'invalid_report', index: 1 }, { status: 422 }) });
    expect(await postRunReports(CFG, new ServiceTokenCache(), named.fetcher, T0, REPORTS)).toEqual({ kind: 'reject', status: 422, code: 'invalid_report', index: 1 });
    const outOfRange = fakeSuperwitness({ runs: () => Response.json({ error: 'invalid_report', index: 7 }, { status: 422 }) });
    expect(await postRunReports(CFG, new ServiceTokenCache(), outOfRange.fetcher, T0, REPORTS)).toEqual({ kind: 'reject', status: 422, code: 'invalid_report', index: null });
  });

  it('other 4xx park, and an error code that is not a plain token is not echoed', async () => {
    const sw = fakeSuperwitness({ runs: () => Response.json({ error: 'Title "Secret plan" too long' }, { status: 400 }) });
    expect(await postRunReports(CFG, new ServiceTokenCache(), sw.fetcher, T0, REPORTS)).toEqual({ kind: 'reject', status: 400, code: 'http_400', index: null });
  });
});

describe('backoff', () => {
  it('doubles from 30 s and caps at 1 h; 12 attempts', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 11].map(runReportBackoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000,
    ]);
    expect(RUN_REPORT_MAX_ATTEMPTS).toBe(12);
  });
});
