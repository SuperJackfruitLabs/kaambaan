/**
 * The OAuth *Resource Server shell* in front of /mcp (docs/05 §2). This file is the whole of it, so
 * read it before believing any prose about OAuth here.
 *
 * What this does: an unauthenticated request gets 401 + WWW-Authenticate pointing at RFC 9728
 * protected-resource metadata, and a bearer is resolved to a principal.
 *
 * What it does NOT do, despite the OAuth vocabulary: there is no authorization server, no
 * /authorize, no /token, no dynamic client registration, no PKCE, and — in particular — **no
 * audience validation**. Nothing here parses a JWT or reads an `aud` claim; a previous version of
 * this comment claimed "validates audience-scoped bearer tokens", which was never true.
 *
 * The two credentials actually accepted are a real `spa_` agent token (SHA-256 hashed and looked up
 * in the catalog — the same credential the REST surface takes) and, only under DEV_AUTH, a
 * self-asserted "<tenantId>:<agentId>:<caps>" bearer with no secret in it.
 *
 * Note the metadata advertises `authorization_servers: [origin]` and this origin serves no AS
 * endpoints, so a client that follows the discovery chain dead-ends. That is the HUB-MODE posture
 * (`ORG_PLANE_ISSUER` unset), and everything above describes it.
 *
 * **Plane mode** (`ORG_PLANE_ISSUER` set, `auth/org-plane.ts`): `/mcp` also accepts Organization
 * plane JWTs, and here audience IS validated — `aud` must be `${ORG_PLANE_AUDIENCE}/mcp`. The
 * challenge names `/.well-known/oauth-protected-resource/mcp` (RFC 9728 §3.1), whose metadata lists
 * `authorization_servers: [ORG_PLANE_ISSUER]`, so discovery ends at the plane. The dev bearer is
 * not accepted in plane mode, and a half-configured switch (`invalid`) refuses everything but `spa_`.
 */
import type { McpAuth } from './tools';
import type { Env } from '../env';
import { hashToken } from '../auth/agent-token';
import { findAgentByTokenHash } from '../db/catalog';
import { effectiveCapabilities } from '../db/implications';
import { orgPlaneMode } from '../auth/org-plane';
import { resolvePlaneMcp } from '../auth/org-plane-resolve';

const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/**
 * Resolve the MCP caller: a real `spa_` agent token (looked up in the catalog) takes precedence; the
 * dev `<tenant>:<agent>:<caps>` bearer is accepted only when DEV_AUTH is on (local + tests).
 */
export async function resolveMcpAuth(request: Request, env: Env): Promise<McpAuth | null> {
  const match = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1]!.trim() : null;
  if (token && token.startsWith('spa_')) {
    const found = await findAgentByTokenHash(env.DB, await hashToken(token));
    if (!found) return null;
    return {
      tenantId: found.tenantId,
      agentId: found.agentId,
      // Declared → effective, expanded ONCE here so `list_work` and `claim_card` cannot disagree.
      // An agent told it has work and then refused it would retry forever, and the two tools take
      // the capability set from the same object precisely so that cannot happen.
      capabilities: await effectiveCapabilities(env.DB, found.tenantId, found.capabilities),
      // Carried, and then actually consulted — see `registerTools`. The lookup has always
      // returned this and this file dropped it, so a `run`-only token could claim over MCP while
      // the identical token was refused `POST /claims` over REST.
      scopes: found.scopes,
      externalId: found.externalId,
    };
  }
  // Plane mode: the plane's tokens for `<app>/mcp`, and nothing self-asserted. `invalid` — the
  // switch set, the rest missing — refuses everything rather than fall back.
  const plane = orgPlaneMode(env);
  if (plane.kind === 'on') return token ? resolvePlaneMcp(request, env, plane.cfg) : null;
  if (plane.kind === 'invalid') return null;
  if (env.DEV_AUTH === 'true') {
    const dev = resolveBearer(request);
    if (!dev) return null;
    // `null`, not `[]`: the dev bearer does not come from `agent_tokens` at all, and
    // `scopePermits` treats null as "unscoped credential" rather than "no permissions" — the same
    // distinction `auth/resolve.ts` calls load-bearing.
    return { ...dev, scopes: null, capabilities: await effectiveCapabilities(env.DB, dev.tenantId, dev.capabilities) };
  }
  return null;
}

/** Parse the dev bearer into a principal, or null if absent/malformed. */
export function resolveBearer(request: Request): McpAuth | null {
  const header = request.headers.get('Authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  // Exactly "<tenant>:<agent>" or "<tenant>:<agent>:<caps>" — reject anything else so a malformed
  // token fails loudly rather than silently dropping the capabilities segment.
  const parts = match[1]!.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const [tenantId, agentId, capsRaw] = parts;
  if (!tenantId || !agentId) return null;
  const capabilities = capsRaw ? capsRaw.split(',').map((c) => c.trim()).filter(Boolean) : [];
  return { tenantId, agentId, capabilities };
}

/** RFC 9728 §3.1: insert the well-known segment between the origin and the resource's path. */
export function metadataUrlFor(resource: string): string {
  const u = new URL(resource);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
  return `${u.origin}${PROTECTED_RESOURCE_PATH}${path}`;
}

export function unauthorized(request: Request, env: Env): Response {
  const plane = orgPlaneMode(env);
  const metadata = plane.kind === 'on'
    ? metadataUrlFor(plane.cfg.mcpAudience)
    : `${new URL(request.url).origin}${PROTECTED_RESOURCE_PATH}`;
  return new Response(JSON.stringify({ error: 'unauthorized', error_description: 'A bearer token is required.' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer resource_metadata="${metadata}"` },
  });
}

/** RFC 9728 metadata for `path`, or null if this deployment does not serve that path. */
export function protectedResourceMetadata(request: Request, env: Env, path: string): Response | null {
  const plane = orgPlaneMode(env);
  if (plane.kind !== 'on') {
    if (path !== PROTECTED_RESOURCE_PATH) return null;
    const origin = new URL(request.url).origin;
    // Unchanged pre-cutover shell — see test/oauth-surface.test.ts, which pins its dead end.
    return Response.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      resource_name: 'superpipeline board worker',
    });
  }
  const { cfg } = plane;
  if (path === new URL(metadataUrlFor(cfg.mcpAudience)).pathname) {
    return Response.json({
      resource: cfg.mcpAudience,
      authorization_servers: [cfg.issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      resource_name: 'superpipeline MCP',
    });
  }
  if (path === PROTECTED_RESOURCE_PATH) {
    return Response.json({
      resource: cfg.audience,
      authorization_servers: [cfg.issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'superpipeline',
    });
  }
  return null;
}

export const MCP_PROTECTED_RESOURCE_PATH = PROTECTED_RESOURCE_PATH;
