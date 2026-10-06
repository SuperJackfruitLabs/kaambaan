/**
 * The Organization plane as this deployment sees it: whether it is on, and what a token from it
 * must look like (accounts `2026-10-06-issuer-contract.md` §§1–2). Verification is the same
 * hardened path the hub's tokens take (`verifyJws`); only the claim shape differs.
 */
import type { JWTPayload } from 'jose';
import type { Env } from '../env';
import { verifyJws } from './hub-jwt';

export const ORG_PLANE_PRODUCT = 'superpipeline';
export const ORG_PLANE_SOURCE = 'org-plane';

const PRN = /^prn_[0-9a-f]{20}$/;
const ORG = /^org_[0-9a-f]{20}$/;

export interface OrgPlaneConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
  mcpAudience: string;
  url: string;
}

export type OrgPlaneMode = { kind: 'off' } | { kind: 'invalid'; reason: string } | { kind: 'on'; cfg: OrgPlaneConfig };

type PlaneEnv = Pick<Env, 'ORG_PLANE_ISSUER' | 'ORG_PLANE_JWKS_URL' | 'ORG_PLANE_AUDIENCE' | 'ORG_PLANE_URL'>;

/** An https URL (http only on loopback), with no credentials, query or fragment; else null. Returned as given, trimmed. */
function safeUrl(raw: string | undefined): string | null {
  const s = (raw ?? '').trim();
  if (s === '') return null;
  try {
    const u = new URL(s);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return s;
  } catch {
    return null;
  }
}

export function orgPlaneMode(env: PlaneEnv): OrgPlaneMode {
  if ((env.ORG_PLANE_ISSUER ?? '').trim() === '') return { kind: 'off' };
  const issuer = safeUrl(env.ORG_PLANE_ISSUER);
  if (!issuer) return { kind: 'invalid', reason: 'ORG_PLANE_ISSUER' };
  const jwksUrl = safeUrl(env.ORG_PLANE_JWKS_URL);
  if (!jwksUrl) return { kind: 'invalid', reason: 'ORG_PLANE_JWKS_URL' };
  const audience = safeUrl(env.ORG_PLANE_AUDIENCE);
  if (!audience) return { kind: 'invalid', reason: 'ORG_PLANE_AUDIENCE' };
  const url = safeUrl(env.ORG_PLANE_URL);
  if (!url) return { kind: 'invalid', reason: 'ORG_PLANE_URL' };
  return {
    kind: 'on',
    cfg: { issuer, jwksUrl, audience, mcpAudience: `${audience.replace(/\/+$/, '')}/mcp`, url: url.replace(/\/+$/, '') },
  };
}

export interface OrgPlaneClaims extends JWTPayload {
  sub: string;
  principalKind: 'human' | 'agent' | 'service';
  org: string;
  ent: string[];
  mayDispatch: string[];
  mayGrantReach: boolean;
  /** Grant scopes — read ONLY on agent/service tokens (contract §2). On OAuth tokens it is the OAuth scope string. */
  scope?: string;
  act?: { sub?: string };
  amr?: string[];
  email?: string;
  email_verified?: boolean;
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Verify a plane token for `audience`, or null. Entitlement is NOT checked here — see `entitles`. */
export async function verifyOrgPlaneToken(
  token: string,
  cfg: OrgPlaneConfig,
  audience: string,
  fetchImpl?: typeof fetch,
): Promise<OrgPlaneClaims | null> {
  const p = await verifyJws(token, {
    issuer: cfg.issuer,
    jwksUrl: cfg.jwksUrl,
    audience,
    requiredClaims: ['exp', 'iat', 'jti', 'sub'],
    fetch: fetchImpl,
  });
  if (!p) return null;
  if (typeof p.sub !== 'string' || !PRN.test(p.sub)) return null;
  const kind = p.principalKind;
  if (kind !== 'human' && kind !== 'agent' && kind !== 'service') return null;
  if (typeof p.org !== 'string' || !ORG.test(p.org)) return null;
  if (!strings(p.ent)) return null;
  if (!strings(p.mayDispatch) || !p.mayDispatch.every((id) => PRN.test(id))) return null;
  if (typeof p.mayGrantReach !== 'boolean') return null;
  return p as OrgPlaneClaims;
}

export function entitles(claims: Pick<OrgPlaneClaims, 'ent'>): boolean {
  return claims.ent.includes(ORG_PLANE_PRODUCT);
}
