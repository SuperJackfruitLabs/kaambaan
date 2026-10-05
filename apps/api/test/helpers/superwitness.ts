import { env } from 'cloudflare:test';

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
