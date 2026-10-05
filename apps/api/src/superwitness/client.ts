/**
 * Talking to the hub and to superwitness for the run reporter (superwitness app spec §3.5).
 *
 * The fetcher is injected so every outcome is testable, the same way push delivery injects its
 * sender. Neither call ever follows a redirect: the bearer must not leave the configured origin.
 */
import type { ReporterConfig } from './config';
import type { RunReport } from './report';

export type ReporterFetch = (url: string, init: RequestInit) => Promise<Response>;
export const defaultReporterFetch: ReporterFetch = (url, init) => fetch(url, init);

/**
 * Give up on a request after this long. A server that accepts and never answers would otherwise
 * hold the drain's single-flight; the abort lands in the same catch as a network error (retryable).
 */
export const REPORTER_FETCH_TIMEOUT_MS = 10_000;
/** Refresh this long before the hub says the token expires. */
export const TOKEN_REFRESH_MARGIN_MS = 30_000;
/** The 12th failed attempt parks the report (ruling R10). */
export const RUN_REPORT_MAX_ATTEMPTS = 12;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 3_600_000;

/** Wait after the `attempts`-th failure: 30 s, 60 s, … capped at 1 h. */
export function runReportBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

type TokenResult = { ok: true; token: string } | { ok: false; status: number; code: string };

/** The reporter's hub token. In memory only — never stored, never logged (ruling R14). */
export class ServiceTokenCache {
  private token: string | null = null;
  private refreshAtMs = 0;

  async get(cfg: ReporterConfig, fetcher: ReporterFetch, nowMs: number): Promise<TokenResult> {
    if (this.token !== null && nowMs < this.refreshAtMs) return { ok: true, token: this.token };
    this.drop();
    let res: Response;
    try {
      res = await fetcher(cfg.tokenUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.credential}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(REPORTER_FETCH_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: 0, code: 'hub_unreachable' };
    }
    if (res.status !== 200) return { ok: false, status: res.status, code: `hub_${res.status}` };
    const body = (await readJson(res)) as { token?: unknown; expiresIn?: unknown } | null;
    if (!body || typeof body.token !== 'string' || body.token === '' || typeof body.expiresIn !== 'number' || !(body.expiresIn > 0)) {
      return { ok: false, status: 200, code: 'hub_bad_response' };
    }
    this.token = body.token;
    this.refreshAtMs = nowMs + body.expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS;
    return { ok: true, token: body.token };
  }

  drop(): void {
    this.token = null;
    this.refreshAtMs = 0;
  }
}

export type PostOutcome =
  | { kind: 'ok'; results: Array<{ external_ref: string; applied: boolean }> }
  | { kind: 'retry'; status: number; code: string; retryAfterMs: number | null }
  | { kind: 'reject'; status: number; code: string; index: number | null };

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * superwitness answers errors as `{"error":{"code","message","index"?}}`. The code is used when it is
 * a plain token, else `http_<status>`; `message` is free text and is never read (R16).
 */
function errorCode(body: unknown, status: number): string {
  const e = (body as { error?: unknown } | null)?.error;
  const nested = (e as { code?: unknown } | null)?.code;
  const code = typeof nested === 'string' ? nested : typeof e === 'string' ? e : null;
  return code !== null && SAFE_CODE.test(code) ? code : `http_${status}`;
}

function retryAfterMs(header: string | null): number | null {
  if (!header || !/^\d{1,6}$/.test(header.trim())) return null;
  return Math.min(Number(header.trim()) * 1000, BACKOFF_MAX_MS);
}

/** The rejected item of a 422, from `error.index` (R11); out of range or absent → null. */
function itemIndex(body: unknown, n: number): number | null {
  const e = (body as { error?: unknown } | null)?.error;
  const i = (e as { index?: unknown } | null)?.index;
  return typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < n ? i : null;
}

/** POST one batch and classify the answer (rulings R9, R10, R11). */
export async function postRunReports(
  cfg: ReporterConfig,
  cache: ServiceTokenCache,
  fetcher: ReporterFetch,
  nowMs: number,
  runs: RunReport[],
): Promise<PostOutcome> {
  const token = await cache.get(cfg, fetcher, nowMs);
  if (!token.ok) return { kind: 'retry', status: token.status, code: token.code, retryAfterMs: null };
  let res: Response;
  try {
    res = await fetcher(cfg.runsUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REPORTER_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'retry', status: 0, code: 'network', retryAfterMs: null };
  }
  const body = await readJson(res);
  if (res.status >= 200 && res.status < 300) {
    const raw = (body as { results?: unknown } | null)?.results;
    const results = Array.isArray(raw)
      ? raw
          .filter((r): r is { external_ref: string; applied: boolean } => typeof r?.external_ref === 'string' && typeof r?.applied === 'boolean')
          .map((r) => ({ external_ref: r.external_ref, applied: r.applied }))
      : [];
    return { kind: 'ok', results };
  }
  const code = errorCode(body, res.status);
  if (res.status === 401 || res.status === 403) cache.drop();
  if (res.status === 401 || res.status === 429 || res.status >= 500) {
    return { kind: 'retry', status: res.status, code, retryAfterMs: res.status === 429 ? retryAfterMs(res.headers.get('Retry-After')) : null };
  }
  if (res.status >= 400) {
    return { kind: 'reject', status: res.status, code, index: res.status === 422 ? itemIndex(body, runs.length) : null };
  }
  // 1xx/3xx: a misconfigured URL. Retryable, so it ends parked after 12 attempts rather than lost.
  return { kind: 'retry', status: res.status, code, retryAfterMs: null };
}
