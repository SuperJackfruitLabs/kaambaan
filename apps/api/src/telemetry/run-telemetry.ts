/**
 * `run.id` on superpipeline's Workers telemetry (superwitness spec §4.1 step 2, C1).
 *
 * Two carriers, because ws1 probe B decides which one joins: a `run_route` custom span
 * (when the runtime has `tracing`), and one structured log line per run-route request
 * carrying `run.id` and the incoming `traceparent`. Neither ever carries a body.
 */
import * as workers from 'cloudflare:workers';

type AttrValue = string | number | boolean | undefined;
export interface SpanLike {
  setAttribute(key: string, value: AttrValue): void;
}
export interface TracingLike {
  enterSpan<T>(name: string, fn: (span: SpanLike) => T): T;
}

export interface RunRouteFacts {
  route: string;
  runId: string;
  boardId: string;
  action: string | null;
}

const RUN_PATH = /^\/v1\/boards\/([^/]+)\/runs\/([^/]+)(?:\/([^/]+))?$/;
const ACTION = /^[a-z][a-z_-]{0,31}$/;

export function runRouteFacts(path: string): RunRouteFacts | null {
  const m = RUN_PATH.exec(path);
  if (!m) return null;
  const action = m[3] ?? null;
  return {
    route: action === null ? '/v1/boards/:id/runs/:runId' : '/v1/boards/:id/runs/:runId/:action',
    runId: decodeURIComponent(m[2]!),
    boardId: decodeURIComponent(m[1]!),
    action: action !== null && ACTION.test(action) ? action : null,
  };
}

function workersTracing(): TracingLike | undefined {
  const t = (workers as unknown as { tracing?: TracingLike }).tracing;
  return t && typeof t.enterSpan === 'function' ? t : undefined;
}

export async function withRunTelemetry(
  request: Request,
  handle: () => Promise<Response>,
  tracing: TracingLike | undefined = workersTracing(),
): Promise<Response> {
  const facts = runRouteFacts(new URL(request.url).pathname);
  if (!facts) return handle();

  // A telemetry failure must never fail or repeat the request.
  const setAttr = (span: SpanLike | null, key: string, value: AttrValue): void => {
    try {
      span?.setAttribute(key, value);
    } catch {
      /* products never block on telemetry */
    }
  };

  const run = async (span: SpanLike | null): Promise<Response> => {
    setAttr(span, 'run.id', facts.runId);
    setAttr(span, 'board.id', facts.boardId);
    setAttr(span, 'http.route', facts.route);
    if (facts.action) setAttr(span, 'run.action', facts.action);
    let status = 500;
    try {
      const res = await handle();
      status = res.status;
      setAttr(span, 'http.response.status_code', status);
      return res;
    } finally {
      console.log({
        level: status >= 500 ? 'error' : 'info',
        msg: 'run route',
        'run.id': facts.runId,
        'board.id': facts.boardId,
        route: facts.route,
        ...(facts.action ? { 'run.action': facts.action } : {}),
        method: request.method,
        status,
        traceparent: request.headers.get('traceparent') ?? undefined,
      });
    }
  };

  if (!tracing) return run(null);
  let started: Promise<Response> | undefined;
  try {
    return await tracing.enterSpan('run_route', (span) => (started = run(span)));
  } catch (err) {
    // If the handler already ran (its own error, rethrown), propagate it; if enterSpan itself failed
    // before calling us, serve the request untraced. Either way the handler runs exactly once.
    if (started) throw err;
    return run(null);
  }
}
