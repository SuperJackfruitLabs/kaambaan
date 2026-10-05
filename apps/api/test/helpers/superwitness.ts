import { env } from 'cloudflare:test';
import type { ReporterFetch } from '../../src/superwitness/client';

export const SW_URL = 'https://sw.test';
export const HUB_URL = 'https://hub.test';
export const CREDENTIAL = 'svc_reporter:s3cret';

type Knob = 'SUPERWITNESS_URL' | 'HUB_ISSUER' | 'SUPERWITNESS_REPORTER_CREDENTIAL';
const KNOBS: Knob[] = ['SUPERWITNESS_URL', 'HUB_ISSUER', 'SUPERWITNESS_REPORTER_CREDENTIAL'];
export const REPORTING_ON: Partial<Record<Knob, string>> = {
  SUPERWITNESS_URL: SW_URL,
  HUB_ISSUER: HUB_URL,
  SUPERWITNESS_REPORTER_CREDENTIAL: CREDENTIAL,
};

/**
 * Configure reporting for the duration of `fn`, then put `env` back exactly as it was. The board
 * DO reads the same `env` object, the way test/control-pair-claim.test.ts toggles enforcement.
 */
export async function withReporting<T>(fn: () => Promise<T>, knobs: Partial<Record<Knob, string>> = REPORTING_ON): Promise<T> {
  const e = env as unknown as Record<string, unknown>;
  const saved = KNOBS.map((k) => [k, k in e, e[k]] as const);
  for (const k of KNOBS) {
    if (knobs[k] === undefined) delete e[k];
    else e[k] = knobs[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, had, v] of saved) {
      if (had) e[k] = v;
      else delete e[k];
    }
  }
}

export function runRow(state: DurableObjectState, runId: string): Record<string, SqlStorageValue> {
  return state.storage.sql.exec(`SELECT * FROM runs WHERE id = ?`, runId).one();
}


export interface SentBatch {
  url: string;
  headers: Record<string, string>;
  raw: string;
  body: { runs: Array<Record<string, unknown>> };
  init: RequestInit;
}

/**
 * A fake hub + superwitness. `runs` answers each POST /v1/runs (default: 200, every item applied);
 * `hub` answers the service-token exchange (default: a fresh 300 s token per call).
 */
export function fakeSuperwitness(
  opts: {
    runs?: (body: SentBatch['body'], n: number) => Response | Promise<Response>;
    hub?: (n: number) => Response | Promise<Response>;
  } = {},
) {
  const batches: SentBatch[] = [];
  let hubCalls = 0;
  const hubInits: RequestInit[] = [];
  const fetcher: ReporterFetch = async (url, init) => {
    if (url === `${HUB_URL}/api/auth/service-token`) {
      hubCalls += 1;
      hubInits.push(init);
      return opts.hub ? opts.hub(hubCalls) : Response.json({ token: `tok-${hubCalls}`, expiresIn: 300 });
    }
    if (url === `${SW_URL}/v1/runs`) {
      const raw = String(init.body);
      const body = JSON.parse(raw) as SentBatch['body'];
      batches.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), raw, body, init });
      if (opts.runs) return opts.runs(body, batches.length);
      return Response.json({ results: body.runs.map((r) => ({ external_ref: r.external_ref, applied: true })) });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetcher, batches, hubCalls: () => hubCalls, hubInits };
}
