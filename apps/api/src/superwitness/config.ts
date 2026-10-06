/**
 * Run reporter configuration (superwitness app spec §3.5). Pure, so misconfiguration is tested
 * without a board.
 */
import type { Env } from '../env';
import { orgPlaneMode } from '../auth/org-plane';

export interface ReporterConfig {
  /** `{SUPERWITNESS_URL}/v1/runs` */
  runsUrl: string;
  /**
   * Where the service credential is exchanged. Hub mode: `{HUB_ISSUER}/api/auth/service-token`
   * (ruling R15). Plane mode: `{ORG_PLANE_URL}/api/token/service` (issuer contract §3.3).
   */
  tokenUrl: string;
  /** `<svc_id>:<secret>` — never logged. */
  credential: string;
  /**
   * The audience the token is requested for: superwitness's own (`SUPERWITNESS_URL`, no trailing
   * slash), in plane mode. Null in hub mode, where the hub decides and the request has no body.
   */
  tokenAudience: string | null;
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
  env: Pick<
    Env,
    | 'SUPERWITNESS_URL'
    | 'HUB_ISSUER'
    | 'SUPERWITNESS_REPORTER_CREDENTIAL'
    | 'ORG_PLANE_ISSUER'
    | 'ORG_PLANE_JWKS_URL'
    | 'ORG_PLANE_AUDIENCE'
    | 'ORG_PLANE_URL'
  >,
): ReporterConfig | { error: string } {
  const sw = httpsUrl(env.SUPERWITNESS_URL);
  if (!sw) return { error: 'superwitness_url_invalid' };
  // A half-set switch reports nothing rather than fall back to the hub (no dual-accept).
  const plane = orgPlaneMode(env);
  if (plane.kind === 'invalid') return { error: 'org_plane_invalid' };
  if (plane.kind === 'on') {
    const credential = env.SUPERWITNESS_REPORTER_CREDENTIAL?.trim() ?? '';
    const colon = credential.indexOf(':');
    if (colon <= 0 || colon === credential.length - 1) return { error: 'credential_missing' };
    return {
      runsUrl: new URL('/v1/runs', sw).toString(),
      tokenUrl: `${plane.cfg.url}/api/token/service`,
      credential,
      tokenAudience: env.SUPERWITNESS_URL!.trim().replace(/\/+$/, ''),
    };
  }
  const hub = httpsUrl(env.HUB_ISSUER);
  if (!hub) return { error: 'hub_issuer_missing' };
  const credential = env.SUPERWITNESS_REPORTER_CREDENTIAL?.trim() ?? '';
  const colon = credential.indexOf(':');
  if (colon <= 0 || colon === credential.length - 1) return { error: 'credential_missing' };
  return {
    runsUrl: new URL('/v1/runs', sw).toString(),
    tokenUrl: new URL('/api/auth/service-token', hub).toString(),
    credential,
    tokenAudience: null,
  };
}
