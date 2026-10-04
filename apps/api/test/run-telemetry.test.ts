import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRouteFacts, withRunTelemetry, type TracingLike } from '../src/telemetry/run-telemetry';

const MARKER = 'CANARY-MARKER-sp1pe';

function fakeTracing() {
  const names: string[] = [];
  const attrs: Record<string, unknown> = {};
  const tracing: TracingLike = {
    enterSpan: (name, fn) => {
      names.push(name);
      return fn({ setAttribute: (k, v) => { attrs[k] = v; } });
    },
  };
  return { tracing, names, attrs };
}

describe('runRouteFacts', () => {
  it('recognises run reads and run verbs, by template', () => {
    expect(runRouteFacts('/v1/boards/brd_1/runs/run_2')).toEqual({ route: '/v1/boards/:id/runs/:runId', runId: 'run_2', boardId: 'brd_1', action: null });
    expect(runRouteFacts('/v1/boards/brd_1/runs/run_2/heartbeat')).toEqual({
      route: '/v1/boards/:id/runs/:runId/:action', runId: 'run_2', boardId: 'brd_1', action: 'heartbeat',
    });
  });
  it('ignores everything else, and refuses an action that is not a plain word', () => {
    expect(runRouteFacts('/v1/boards/brd_1/claims')).toBeNull();
    expect(runRouteFacts('/health')).toBeNull();
    expect(runRouteFacts('/v1/boards/brd_1/runs/run_2/' + 'x'.repeat(40))?.action).toBeNull();
  });
});

describe('withRunTelemetry', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  afterEach(() => log.mockClear());

  it('puts run.id on the span and one structured line in the log, never the body', async () => {
    const { tracing, names, attrs } = fakeTracing();
    const req = new Request('https://api.test/v1/boards/brd_1/runs/run_2/activities', {
      method: 'POST',
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
      body: JSON.stringify({ body: MARKER }),
    });
    const res = await withRunTelemetry(req, async () => Response.json({ echoed: MARKER }, { status: 201 }), tracing);
    expect(res.status).toBe(201);
    expect(names).toEqual(['run_route']);
    expect(attrs).toMatchObject({ 'run.id': 'run_2', 'board.id': 'brd_1', 'http.route': '/v1/boards/:id/runs/:runId/:action', 'run.action': 'activities', 'http.response.status_code': 201 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatchObject({
      msg: 'run route', 'run.id': 'run_2', 'board.id': 'brd_1', method: 'POST', status: 201,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    expect(JSON.stringify([attrs, log.mock.calls])).not.toContain(MARKER);
  });

  it('logs a thrown handler as status 500 and rethrows', async () => {
    const { tracing } = fakeTracing();
    const req = new Request('https://api.test/v1/boards/brd_1/runs/run_2');
    await expect(withRunTelemetry(req, async () => { throw new Error(MARKER); }, tracing)).rejects.toThrow(MARKER);
    expect(log.mock.calls[0]![0]).toMatchObject({ 'run.id': 'run_2', status: 500, level: 'error' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(MARKER);
  });

  it('works when the runtime offers no tracing API', async () => {
    const req = new Request('https://api.test/v1/boards/brd_1/runs/run_2');
    const res = await withRunTelemetry(req, async () => new Response('ok'), undefined);
    expect(res.status).toBe(200);
    expect(log.mock.calls[0]![0]).toMatchObject({ 'run.id': 'run_2' });
  });

  it('leaves other routes completely alone', async () => {
    const { tracing, names } = fakeTracing();
    await withRunTelemetry(new Request('https://api.test/health'), async () => new Response('ok'), tracing);
    expect(names).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('serves the request exactly once when the tracing API throws', async () => {
    const req = new Request('https://api.test/v1/boards/brd_1/runs/run_2');
    let calls = 0;
    const handler = async () => { calls += 1; return new Response('ok'); };
    const before: TracingLike = { enterSpan: () => { throw new Error('boom'); } };
    expect((await withRunTelemetry(req, handler, before)).status).toBe(200);
    expect(calls).toBe(1);
    const attr: TracingLike = { enterSpan: (_n, fn) => fn({ setAttribute: () => { throw new Error('boom'); } }) };
    expect((await withRunTelemetry(req, handler, attr)).status).toBe(200);
    expect(calls).toBe(2);
  });

  it('finds the real cloudflare:workers tracing API in the Workers runtime', async () => {
    const res = await withRunTelemetry(new Request('https://api.test/v1/boards/brd_1/runs/run_2'), async () => new Response('ok'));
    expect(res.status).toBe(200);
  });
});
