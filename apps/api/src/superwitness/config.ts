/**
 * Run reporter configuration (superwitness app spec §3.5). Pure, so misconfiguration is tested
 * without a board.
 */
import type { Env } from '../env';

export interface ReporterConfig {
  /** `{SUPERWITNESS_URL}/v1/runs` */
  runsUrl: string;
  /** `{HUB_ISSUER}/api/auth/service-token` (ruling R15) */
  tokenUrl: string;
  /** `<svc_id>:<secret>` — never logged. */
  credential: string;
}

/** Reporting is on exactly when SUPERWITNESS_URL is set; off means the outbox is never written. */
export function reportingEnabled(env: Pick<Env, 'SUPERWITNESS_URL'>): boolean {
  return typeof env.SUPERWITNESS_URL === 'string' && env.SUPERWITNESS_URL.trim() !== '';
}

function httpsUrl(v: string | undefined): URL | null {
  if (!v || v.trim() === '') return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Everything the drain needs, or the reason it cannot send (a short code, safe to log). */
export function reporterConfig(
  env: Pick<Env, 'SUPERWITNESS_URL' | 'HUB_ISSUER' | 'SUPERWITNESS_REPORTER_CREDENTIAL'>,
): ReporterConfig | { error: string } {
  const sw = httpsUrl(env.SUPERWITNESS_URL);
  if (!sw) return { error: 'superwitness_url_invalid' };
  const hub = httpsUrl(env.HUB_ISSUER);
  if (!hub) return { error: 'hub_issuer_missing' };
  const credential = env.SUPERWITNESS_REPORTER_CREDENTIAL?.trim() ?? '';
  const colon = credential.indexOf(':');
  if (colon <= 0 || colon === credential.length - 1) return { error: 'credential_missing' };
  return {
    runsUrl: new URL('/v1/runs', sw).toString(),
    tokenUrl: new URL('/api/auth/service-token', hub).toString(),
    credential,
  };
}
