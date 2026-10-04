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

const MAX_ID = 128;
const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Decode a path segment without ever throwing, and cap its length (ids come from the unauthenticated URL). */
function safeId(segment: string): string {
  let v = segment;
  try {
    v = decodeURIComponent(segment);
  } catch {
    /* malformed escape: keep the raw segment */
  }
  return v.length > MAX_ID ? v.slice(0, MAX_ID) : v;
}

export function runRouteFacts(path: string): RunRouteFacts | null {
  const m = RUN_PATH.exec(path);
  if (!m) return null;
  const action = m[3] ?? null;
  return {
    route: action === null ? '/v1/boards/:id/runs/:runId' : '/v1/boards/:id/runs/:runId/:action',
    runId: safeId(m[2]!),
    boardId: safeId(m[1]!),
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
  let facts: RunRouteFacts | null = null;
  try {
    facts = runRouteFacts(new URL(request.url).pathname);
  } catch {
    /* products never block on telemetry */
  }
  if (!facts) return handle();

  // A telemetry failure must never fail or repeat the request.
  const setAttr = (span: SpanLike | null, key: string, value: AttrValue): void => {
    try {
      span?.setAttribute(key, value);
    } catch {
      /* products never block on telemetry */
    }
  };

  const f: RunRouteFacts = facts;
  const run = async (span: SpanLike | null): Promise<Response> => {
    setAttr(span, 'run.id', f.runId);
    setAttr(span, 'board.id', f.boardId);
    setAttr(span, 'http.route', f.route);
    if (f.action) setAttr(span, 'run.action', f.action);
    let status = 500;
    try {
      const res = await handle();
      status = res.status;
      setAttr(span, 'http.response.status_code', status);
      return res;
    } finally {
      try {
        const tp = request.headers.get('traceparent')?.toLowerCase();
        const entry = {
          level: status >= 500 ? 'error' : 'info',
          msg: 'run route',
          'run.id': f.runId,
          'board.id': f.boardId,
          route: f.route,
          ...(f.action ? { 'run.action': f.action } : {}),
          method: request.method,
          status,
          ...(tp && TRACEPARENT.test(tp) ? { traceparent: tp } : {}),
        };
        // Workers derives the exported severity from the console method.
        if (status >= 500) console.error(entry);
        else console.log(entry);
      } catch {
        /* a logging failure must never fail the request */
      }
    }
  };

  if (!tracing) return run(null);
  let started: Promise<Response> | undefined;
  try {
    return await tracing.enterSpan('run_route', (span) => (started = run(span)));
  } catch (err) {
    // If enterSpan itself failed before calling us, serve the request untraced. Either way the handler runs exactly once.
    // If enterSpan fails AFTER the handler finished (e.g. ending the span), the handler's result stands.
    if (started) return await started;
    return run(null);
  }
}
