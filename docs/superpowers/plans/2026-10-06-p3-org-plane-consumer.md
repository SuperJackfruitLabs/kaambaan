# P3 — Superpipeline consumes the Organization plane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Superpipeline accepts tokens from the Organization plane (`accounts.superjackfruit.com`) once `ORG_PLANE_ISSUER` is set, and behaves exactly as today while it is unset.

**Architecture:** One switch, `ORG_PLANE_ISSUER`, read by a single pure function (`orgPlaneMode`). When it is on, the three existing hub resolvers (`resolveHubUser`, `resolveHubAgent`, `resolveHubService`), the MCP resolver, the web sign-in routes, the run reporter's token exchange and `supi`'s credential path each take their plane branch. No hub token is accepted in that mode (no dual-accept). The JWKS cache in `hub-jwt.ts` is generalised to key on a JWKS URL, so both issuers share one hardened verifier. Tenants, users and agents are mapped through `external_source = 'org-plane'`. Existing production rows are re-pointed by a dry-run-first script run during P4.

**Tech Stack:** Cloudflare Workers + D1 (SQLite) + Durable Objects, `jose` 6, `@modelcontextprotocol/sdk`, vitest 4 with `@cloudflare/vitest-pool-workers` (api), vitest (cli and web, node), SvelteKit 2 / Svelte 5 (web), Bun for operator scripts.

**Spec:** `accounts` repo, `docs/superpowers/specs/2026-10-06-issuer-contract.md` (authoritative; §4 lists this repo's changes). Background: `accounts` `docs/superpowers/specs/2026-10-06-organization-plane-design.md` §§5, 7.2, 8, 9. Where the two differ, the contract wins. One amendment from the P2 plan is applied here and wins over the contract's §3.1 text: `iss` is the root origin for every token, and authorization-server discovery is at the root `/.well-known/oauth-authorization-server`.

## Global Constraints

- **Superpipeline deploys to production on every merge to `main`** (`.github/workflows/ci.yml` runs `db:migrate` then `deploy`). There is no staging. Every task must be safe to deploy alone **with `ORG_PLANE_*` unset**, and every task carries a test proving that.
- **Cutover rule (contract §1):** until cutover the `ORG_PLANE_*` settings are absent and the product behaves exactly as today. Setting them switches the product to the plane. **There is no dual-accept.** In plane mode a hub-issued token is refused everywhere.
- **The switch is `ORG_PLANE_ISSUER`.** If it is set but any other `ORG_PLANE_*` value is missing or malformed, the mode is `invalid`: every JWT path fails closed, and GitHub sign-in stays off. A half-configured switch must never fall back to the hub.
- Configuration (contract §1), all four required in plane mode: `ORG_PLANE_ISSUER` (exact `iss`, never a prefix match), `ORG_PLANE_JWKS_URL`, `ORG_PLANE_AUDIENCE` (`https://app.superpipeline.dev` in production), `ORG_PLANE_URL` (base for the plane's APIs and OAuth endpoints). The MCP audience is derived: `${ORG_PLANE_AUDIENCE}/mcp`.
- Products must not hard-code anything except claim names. Every plane URL comes from configuration, or (for `supi`) from this server's RFC 9728 metadata.
- Token rules (contract §2): JWS `alg: EdDSA` only, `kid` from the JWKS. Accept `aud` as a string or an array that contains the audience. Always-present claims: `iss sub aud exp iat jti principalKind org ent mayDispatch mayGrantReach`. `tenant` is removed. Read grant `scope` only from `agent` or `service` tokens.
- JWKS (contract §1, design §5.5): cache ≤ 10 minutes, refetch once on an unknown `kid`, serve the last good set when the plane is unreachable. Keep the existing implementation; do not replace it with `createRemoteJWKSet` (see the comment in `hub-jwt.ts:161-179`).
- Entitlement (contract §2): a token whose `ent` lacks `superpipeline` gets `403` with body exactly `{ "error": "product_not_enabled", "org": "<org_ id>" }`. Never a bare 403.
- First sight (contract §2): a valid token whose `org` has no local tenant, and whose `ent` contains `superpipeline`, creates that tenant mapped `external_source = 'org-plane'`, `external_id = <org_ id>`. Superpipeline never calls the plane to do this.
- Web client (contract §3.1): `client_id = superpipeline-web`, redirect `https://app.superpipeline.dev/auth/callback`, PKCE S256, and **the token request must carry `resource=<audience>`**.
- Terminal (contract §3.2): `client_id = "supi"`; `/api/auth/device/token` returns `{ "device_credential": "dev_<20 hex>:<43 base64url>" }`, not an RFC 8628 token response; tokens come from `POST /api/token/device { audience }`.
- **Issuer and discovery (P2 plan, supersedes contract §3.1's suffixed path):** the plane pins `iss` to the root, `https://accounts.superjackfruit.com`, for OAuth tokens and exchange mints alike. Authorization-server discovery is at the root: `https://accounts.superjackfruit.com/.well-known/oauth-authorization-server`. Superpipeline's RFC 9728 metadata lists `authorization_servers: [ORG_PLANE_ISSUER]`, exactly the configured value, never a derived or `/api/auth`-suffixed one.
- **An OAuth token's `org` is fixed at consent time.** A refresh keeps the same `org`. Switching workspace needs a fresh authorize (`/auth/login`), never a refresh. The session's tenant is always the `org` of the access token minted at that sign-in.
- Id grammar used for validation: `prn_[0-9a-f]{20}`, `org_[0-9a-f]{20}` (same shape as `PRINCIPAL_ID` at `apps/api/src/db/catalog.ts:472`).
- Never put a local deployment's names (agent names, "guild") in code, tests or docs. The product word is *workspace*.
- Test-first, and revert-proof every guard: after a step makes a test pass, revert the guarded line once and watch the test go red.
- Commands run from the repo root. Api tests: `pnpm --filter @superpipeline/api exec vitest run <file>`; full: `pnpm --filter @superpipeline/api test`. Cli: `pnpm --filter @superpipeline/cli exec vitest run <file>`. Web: `pnpm --filter @superpipeline/web exec vitest run <file>`. Before each PR: `pnpm typecheck && pnpm test`.
- One PR per task (or per adjacent pair at most). Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A person whose GitHub-created account has the same verified address, but whose row is still mapped to the hub (`external_source = 'agentpod'`)** — expected: plane sign-in refuses to adopt it (no duplicate user, no capture). The re-point script moves the mapping during P4. Pinned in Task 3.
2. **A board view fires many requests at once on a first visit** — expected: exactly one tenant per `org` and one membership per person, never two owners from one race. Pinned in Task 3 (concurrent `Promise.all`).
3. **The plane is unreachable while a valid token arrives** — expected: with a warm cache the verify makes **zero** network calls and succeeds. A token whose `kid` is unknown makes exactly one refetch and is then refused. Pinned in Task 1.
4. **The SPA after five minutes**, when the access token cookie has lapsed — expected: `/hub/token` renews silently through the rotating refresh token, and the board keeps carrying dispatch authority. Pinned in Task 6.
5. **Rollback**: unset `ORG_PLANE_*` — expected: hub tokens resolve again with no code change, and plane tokens are refused. Pinned in Task 4 (one test runs the same request in both modes).

## Inventory: what this repository does today (verified at `origin/main` 2c848dc)

| Area | Code | Today | After cutover (this plan) |
|---|---|---|---|
| Verifier | `apps/api/src/auth/hub-jwt.ts:277-369` `verifyHubToken` | EdDSA only (`:306`), `kid` required (`:307`), refetch once on unknown kid (`:245-268`), JWKS URL hard-coded `${issuer}/api/auth/jwks` (`:222`), cache keyed by issuer (`:186`), requires `tenant` (`:355-356`). jose already accepts a string or array `aud` (`:344`). | Core extracted to `verifyJws` keyed by JWKS URL; `verifyOrgPlaneToken` added beside `verifyHubToken` (Task 1). |
| Human bearer | `apps/api/src/auth/resolve.ts:222-261` `resolveHubUser` | tenant from `('agentpod', claims.tenant)` (`:240`), user from `('agentpod', claims.sub)` (`:255`), stranger → `member`. | Plane branch: tenant from `('org-plane', org)` with first sight; user by `('org-plane', sub)` (Task 4). |
| Agent bearer | `resolve.ts:293-334` `resolveHubAgent` | agent by `('org-plane', sub)` already (`:306`); tenant check via `('agentpod', tenant)` (`:312`). | Tenant check via `('org-plane', org)` (Task 4). Agent rows need no re-point. |
| Service bearer | `resolve.ts:358-372` `resolveHubService` | superwitness reading evidence; tenant via fleet. | Tenant via `org`; scopes from `scope` (Task 4). |
| MCP | `apps/api/src/mcp/auth.ts:34-63`, metadata `:93-102`, challenge `:81-90` | `spa_` only; metadata names this origin as an AS it does not serve. | Plane tokens for `…/mcp`; metadata points at the plane (Task 5). |
| Web sign-in | `apps/api/src/auth/routes.ts:35-71` (GitHub), `apps/api/src/auth/hub-oauth.ts:441-614` (hub PKCE handoff) | GitHub login; hub PKCE client `superpipeline` with callback `/hub/callback`, posting to `/api/auth/token/exchange` (`:499`). | `/auth/login` + `/auth/callback` become the plane PKCE client `superpipeline-web`; GitHub is off (Task 6). `hub-oauth.ts`'s PKCE helpers are reused; its hub-specific exchange is not. |
| SPA authority | `apps/web/src/lib/hub-token.ts:100-221`, `apps/web/src/lib/components/Landing.svelte:112-128` | Reads `/hub/token`; falls back to a cross-site call to the hub; "Sign in with GitHub". | `/hub/token` serves the plane access token and refreshes it; one "Sign in" button (Tasks 6–7). |
| Run reporter (service → hub) | `apps/api/src/superwitness/config.ts:32-47`, `client.ts:33-64` | `POST {HUB_ISSUER}/api/auth/service-token`, `Bearer svc_…`, response `{ token, expiresIn }`. | `POST {ORG_PLANE_URL}/api/token/service { audience: SUPERWITNESS_URL }`, response `{ access_token, expires_in }` (Task 8). |
| CLI | `packages/cli/src/credential.ts:123-281` | Reads `fleet login`'s files; renews at `{hub}/api/auth/devices/token?client=apn`. | `supi login` (device flow, `client_id=supi`), own `device.json`, exchange at `/api/token/device` (Task 9). |
| Tenant link | `apps/api/src/index.ts:550-605` `PATCH /v1/tenant` | Writes `('agentpod', fleet_…)`. | Refused in plane mode, so it cannot overwrite an `org-plane` mapping (Task 4). |
| Evidence ids | `apps/api/src/db/catalog.ts:479-489` `userExternalIds` | Reads `external_source = 'agentpod'` only. | Also reads `'org-plane'` (Task 4). |

### Service-to-hub calls (scope item 6)

Superpipeline makes **no dispatch calls to the hub**; agents claim work themselves. The complete list of calls that leave this repository for the hub:

| # | Caller | Call | After cutover |
|---|---|---|---|
| 1 | Worker, every JWT verify | `GET {HUB_ISSUER}/api/auth/jwks` (`hub-jwt.ts:222`) | `GET {ORG_PLANE_JWKS_URL}`. |
| 2 | Worker, `/hub/callback` | `POST {HUB_ISSUER}/api/auth/token/exchange` (`hub-oauth.ts:499`) | Not called. Replaced by `POST {ORG_PLANE_URL}/api/auth/oauth2/token` with `resource=https://app.superpipeline.dev` (Task 6). `/hub/callback` answers 404 in plane mode. |
| 3 | Worker, run reporter | `POST {HUB_ISSUER}/api/auth/service-token` (`superwitness/config.ts:44`) | `POST {ORG_PLANE_URL}/api/token/service { audience: <SUPERWITNESS_URL> }` with the reporter's plane `svc_` credential. The token's audience is superwitness's, not ours (Task 8). |
| 4 | Browser, `hubToken()` fallback | `GET {PUBLIC_HUB_URL}/api/auth/token` (`apps/web/src/lib/hub-token.ts:123`) | Skipped in plane mode (Task 7). |
| 5 | Browser, assignee picker | `GET {PUBLIC_HUB_URL}/api/fleet/dispatchable` with the token from `/hub/token` (`apps/web/src/lib/api.ts:864-879`) | **Open question.** The token the SPA holds will have `aud = https://app.superpipeline.dev`, which the hub refuses. Task 7 makes the call return `null` (the picker shows nothing, which it already handles) rather than send a token the hub will reject. Restoring it needs a hub-audience token for the browser, for example a second refresh-token grant with `resource=https://hub.agentpod.dev`. That needs the plane to allow `superpipeline-web` that resource. Not built here. |
| 6 | `supi` renewal | `POST {fleet hub}/api/auth/devices/token?client=apn` (`credential.ts:236`) | Kept for hub mode only. `supi login` supersedes it (Task 9). |

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/env.ts` | Four new optional vars | 1 |
| `apps/api/src/auth/hub-jwt.ts` | Shared `verifyJws` core keyed by JWKS URL; `verifyHubToken` unchanged in behaviour | 1 |
| `apps/api/src/auth/org-plane.ts` (new) | `orgPlaneMode`, `OrgPlaneClaims`, `verifyOrgPlaneToken`, `entitles` | 1 |
| `apps/api/test/helpers/org-plane.ts` (new) | Local Ed25519 plane: keys, JWKS, `planeToken`, `withOrgPlane` | 1 |
| `apps/api/test/fixtures/org-plane-token-claims.json` (new) | Contract §2, as data | 2 |
| `apps/api/migrations/0017_org_plane_tenant_unique.sql` (new) | One tenant per `org` | 3 |
| `apps/api/src/auth/org-tenancy.ts` (new) | `ensureOrgTenant`, `provisionOrgHuman` | 3 |
| `apps/api/src/auth/org-plane-resolve.ts` (new) | Per-request memoised verify; plane user/agent/service/MCP resolvers; entitlement refusal | 4, 5 |
| `apps/api/src/auth/resolve.ts` | Plane branch at the top of the three hub resolvers | 4 |
| `apps/api/src/index.ts` | Entitlement gate; `PATCH /v1/tenant` guard; plane route dispatch; RFC 9728 paths | 4, 5, 6 |
| `apps/api/src/mcp/auth.ts` | Plane tokens; metadata and challenge in plane mode | 5 |
| `apps/api/src/auth/plane-signin.ts` (new) | `/auth/login`, `/auth/callback`, `/auth/logout`, `/hub/token`, `/hub/connect`, `/hub/callback` in plane mode | 6 |
| `apps/api/src/auth/hub-oauth.ts` | Export PKCE helpers; `/hub/token` adds `signIn: 'github'` | 6 |
| `apps/web/src/lib/hub-token.ts`, `apps/web/src/lib/sign-in.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/components/Landing.svelte` | Plane-aware sign-in UI and authority | 7 |
| `apps/api/src/superwitness/config.ts`, `client.ts` | Reporter token from the plane | 8 |
| `packages/cli/src/plane-login.ts` (new), `credential.ts`, `index.ts`, `README.md` | `supi login` / `supi logout`, resolution order | 9 |
| `apps/api/src/db/repoint-org-plane.ts` (new), `scripts/repoint-org-plane.ts` (new), `docs/12-deploy.md` | Cutover data re-point and runbook | 10 |

---

### Task 1: Plane configuration and verifier

**Files:**
- Modify: `apps/api/src/env.ts:24` (add four vars after `HUB_ISSUER`)
- Modify: `apps/api/src/auth/hub-jwt.ts:186-369` (extract `verifyJws`, key the cache by JWKS URL)
- Create: `apps/api/src/auth/org-plane.ts`
- Create: `apps/api/test/helpers/org-plane.ts`
- Test: `apps/api/test/org-plane-verify.test.ts`
- Modify: `apps/api/wrangler.jsonc:30-40` (a comment naming the four vars and saying they are absent until P4; **no values**)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `hub-jwt.ts`: `export interface JwsOptions { issuer: string; jwksUrl: string; audience: string; requiredClaims: string[]; fetch?: typeof fetch }` and `export async function verifyJws(token: string, opts: JwsOptions): Promise<JWTPayload | null>`. `verifyHubToken` keeps its signature and behaviour. `__resetJwksCacheForTests` still clears everything.
  - `org-plane.ts`:
    - `export const ORG_PLANE_PRODUCT = 'superpipeline'`
    - `export const ORG_PLANE_SOURCE = 'org-plane'`
    - `export interface OrgPlaneConfig { issuer: string; jwksUrl: string; audience: string; mcpAudience: string; url: string }`
    - `export type OrgPlaneMode = { kind: 'off' } | { kind: 'invalid'; reason: string } | { kind: 'on'; cfg: OrgPlaneConfig }`
    - `export function orgPlaneMode(env: Pick<Env, 'ORG_PLANE_ISSUER' | 'ORG_PLANE_JWKS_URL' | 'ORG_PLANE_AUDIENCE' | 'ORG_PLANE_URL'>): OrgPlaneMode`
    - `export interface OrgPlaneClaims extends JWTPayload { sub: string; principalKind: 'human' | 'agent' | 'service'; org: string; ent: string[]; mayDispatch: string[]; mayGrantReach: boolean; scope?: string; act?: { sub?: string }; amr?: string[]; email?: string; email_verified?: boolean }`
    - `export async function verifyOrgPlaneToken(token: string, cfg: OrgPlaneConfig, audience: string, fetchImpl?: typeof fetch): Promise<OrgPlaneClaims | null>`
    - `export function entitles(claims: Pick<OrgPlaneClaims, 'ent'>): boolean`
  - `test/helpers/org-plane.ts`:
    - constants `PLANE`, `PLANE_JWKS`, `APP_AUD`, `MCP_AUD`, `ORG`, `OTHER_ORG`, `HUMAN`, `AGENT`, `SERVICE`, `PLANE_ENV`
    - `planeToken(over?, opts?)`
    - `planeKeys()`
    - `withOrgPlane(fn, extra?)`
    - `planeEnv(over?)`

- [ ] **Step 1: Write the test helper** (`apps/api/test/helpers/org-plane.ts`)

```ts
import { env } from 'cloudflare:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { __resetJwksCacheForTests } from '../../src/auth/hub-jwt';
import type { Env } from '../../src/env';

/** A local Organization plane: an Ed25519 key, its JWKS, and tokens shaped as contract §2. */
export const PLANE = 'https://accounts.test';
export const PLANE_JWKS = `${PLANE}/api/auth/jwks`;
/** vitest.config.ts pins APP_URL to this origin; the plane audience is configured to match. */
export const APP_AUD = 'https://api.test';
export const MCP_AUD = `${APP_AUD}/mcp`;
export const ORG = 'org_00000000000000000a01';
export const OTHER_ORG = 'org_00000000000000000b02';
export const HUMAN = 'prn_000000000000000000a1';
export const AGENT = 'prn_000000000000000000a2';
export const SERVICE = 'prn_000000000000000000a3';
export const KID = 'plane-kid-1';

export const PLANE_ENV = {
  ORG_PLANE_ISSUER: PLANE,
  ORG_PLANE_JWKS_URL: PLANE_JWKS,
  ORG_PLANE_AUDIENCE: APP_AUD,
  ORG_PLANE_URL: PLANE,
} as const;

let once: Promise<{ privateKey: CryptoKey; jwksBody: string }> | null = null;
export function planeKeys() {
  once ??= (async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    const jwk = await exportJWK(pair.publicKey);
    return { privateKey: pair.privateKey, jwksBody: JSON.stringify({ keys: [{ ...jwk, alg: 'EdDSA', kid: KID }] }) };
  })();
  return once;
}

/**
 * A plane token. Defaults to a human in ORG entitled to superpipeline, with `aud` as the ARRAY the
 * OAuth provider really issues (Gate 1 findings Q1: the resource plus the userinfo endpoint).
 */
export async function planeToken(
  over: Record<string, unknown> = {},
  opts: { aud?: string | string[]; iss?: string; kid?: string; key?: CryptoKey; exp?: string } = {},
): Promise<string> {
  const { privateKey } = await planeKeys();
  const payload: Record<string, unknown> = {
    sub: HUMAN,
    principalKind: 'human',
    org: ORG,
    ent: ['superpipeline'],
    mayDispatch: [],
    mayGrantReach: false,
    jti: crypto.randomUUID(),
    email: 'person@example.com',
    email_verified: true,
    ...over,
  };
  for (const [k, v] of Object.entries(payload)) if (v === undefined) delete payload[k];
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: opts.kid ?? KID })
    .setIssuer(opts.iss ?? PLANE)
    .setAudience(opts.aud ?? [APP_AUD, `${PLANE}/api/auth/oauth2/userinfo`])
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? privateKey);
}

/** The worker's `env` with plane mode on, for direct calls to resolvers. */
export function planeEnv(over: Record<string, unknown> = {}): Env {
  return { ...env, ...PLANE_ENV, ...over } as unknown as Env;
}

/**
 * Turn plane mode on for `SELF.fetch` tests: set the four vars on the shared `env`, answer the
 * JWKS URL locally, and record every outbound URL so "no network" is measured. `extra` may answer
 * other plane endpoints; returning null passes the request through to the real fetch.
 */
export async function withOrgPlane<T>(
  fn: (calls: string[]) => Promise<T>,
  extra?: (url: string, init?: RequestInit) => Response | null | Promise<Response | null>,
): Promise<T> {
  const { jwksBody } = await planeKeys();
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const bag = env as unknown as Record<string, unknown>;
  Object.assign(bag, PLANE_ENV);
  __resetJwksCacheForTests();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url === PLANE_JWKS) return new Response(jwksBody, { headers: { 'content-type': 'application/json' } });
    const answered = extra ? await extra(url, init) : null;
    if (answered) return answered;
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(PLANE_ENV)) delete bag[k];
    __resetJwksCacheForTests();
  }
}
```

- [ ] **Step 2: Write the failing test** (`apps/api/test/org-plane-verify.test.ts`)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { orgPlaneMode, verifyOrgPlaneToken, entitles, type OrgPlaneConfig } from '../src/auth/org-plane';
import { __resetJwksCacheForTests, verifyHubToken } from '../src/auth/hub-jwt';
import { PLANE, PLANE_JWKS, APP_AUD, MCP_AUD, ORG, HUMAN, PLANE_ENV, planeKeys, planeToken } from './helpers/org-plane';

const CFG: OrgPlaneConfig = { issuer: PLANE, jwksUrl: PLANE_JWKS, audience: APP_AUD, mcpAudience: MCP_AUD, url: PLANE };

let calls: string[] = [];
let jwksUp = true;
const fetchImpl = (async (input: RequestInfo | URL) => {
  const url = String(input);
  calls.push(url);
  if (url === PLANE_JWKS && jwksUp) {
    return new Response((await planeKeys()).jwksBody, { headers: { 'content-type': 'application/json' } });
  }
  return new Response('down', { status: 503 });
}) as unknown as typeof fetch;

beforeEach(() => {
  __resetJwksCacheForTests();
  calls = [];
  jwksUp = true;
});

describe('orgPlaneMode — the one switch', () => {
  it('is off when ORG_PLANE_ISSUER is unset, whatever else is set', () => {
    expect(orgPlaneMode({ ...PLANE_ENV, ORG_PLANE_ISSUER: undefined })).toEqual({ kind: 'off' });
    expect(orgPlaneMode({ ...PLANE_ENV, ORG_PLANE_ISSUER: '  ' })).toEqual({ kind: 'off' });
  });

  it('is invalid — not off — when the issuer is set and anything else is missing or unsafe', () => {
    for (const broken of [
      { ORG_PLANE_JWKS_URL: undefined },
      { ORG_PLANE_AUDIENCE: '' },
      { ORG_PLANE_URL: 'not a url' },
      { ORG_PLANE_JWKS_URL: 'http://accounts.test/api/auth/jwks' }, // plain http off loopback
      { ORG_PLANE_ISSUER: 'ftp://accounts.test' },
    ]) {
      expect(orgPlaneMode({ ...PLANE_ENV, ...broken }).kind, JSON.stringify(broken)).toBe('invalid');
    }
  });

  it('is on with every value, and derives the MCP audience from the app audience', () => {
    expect(orgPlaneMode(PLANE_ENV)).toEqual({ kind: 'on', cfg: CFG });
  });

  it('keeps the issuer EXACT — a trailing slash is a different issuer, not a typo to forgive', () => {
    const mode = orgPlaneMode({ ...PLANE_ENV, ORG_PLANE_ISSUER: `${PLANE}/` });
    expect(mode.kind === 'on' && mode.cfg.issuer).toBe(`${PLANE}/`);
  });
});

describe('verifyOrgPlaneToken', () => {
  it('accepts aud as an array containing the audience', async () => {
    const claims = await verifyOrgPlaneToken(await planeToken(), CFG, APP_AUD, fetchImpl);
    expect(claims?.sub).toBe(HUMAN);
    expect(claims?.org).toBe(ORG);
    expect(entitles(claims!)).toBe(true);
  });

  it('accepts aud as a plain string', async () => {
    expect(await verifyOrgPlaneToken(await planeToken({}, { aud: APP_AUD }), CFG, APP_AUD, fetchImpl)).not.toBeNull();
  });

  it('refuses a token minted for the MCP resource at the app, and the reverse', async () => {
    expect(await verifyOrgPlaneToken(await planeToken({}, { aud: MCP_AUD }), CFG, APP_AUD, fetchImpl)).toBeNull();
    expect(await verifyOrgPlaneToken(await planeToken({}, { aud: APP_AUD }), CFG, MCP_AUD, fetchImpl)).toBeNull();
  });

  it('refuses a token minted for another product (the hub)', async () => {
    expect(await verifyOrgPlaneToken(await planeToken({}, { aud: 'https://hub.agentpod.dev' }), CFG, APP_AUD, fetchImpl)).toBeNull();
  });

  it('refuses another issuer, including a prefix of ours', async () => {
    expect(await verifyOrgPlaneToken(await planeToken({}, { iss: `${PLANE}/api/auth` }), CFG, APP_AUD, fetchImpl)).toBeNull();
  });

  it('refuses any algorithm but EdDSA, before fetching keys', async () => {
    const hs = await new SignJWT({ sub: HUMAN, principalKind: 'human', org: ORG, ent: ['superpipeline'], mayDispatch: [], mayGrantReach: false, jti: 'x' })
      .setProtectedHeader({ alg: 'HS256', kid: 'plane-kid-1' })
      .setIssuer(PLANE).setAudience(APP_AUD).setIssuedAt().setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-shared-secret-of-sufficient-length!!'));
    expect(await verifyOrgPlaneToken(hs, CFG, APP_AUD, fetchImpl)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('refuses a hub-shaped token that carries tenant instead of org', async () => {
    const hubShaped = await planeToken({ org: undefined, tenant: 'fleet_0123456789abcdef0123' });
    expect(await verifyOrgPlaneToken(hubShaped, CFG, APP_AUD, fetchImpl)).toBeNull();
  });

  it.each([
    ['sub', { sub: 'user_not_a_principal' }],
    ['principalKind', { principalKind: 'robot' }],
    ['org', { org: 'fleet_0123456789abcdef0123' }],
    ['ent', { ent: 'superpipeline' }],
    ['mayDispatch', { mayDispatch: ['agt_local'] }],
    ['mayGrantReach', { mayGrantReach: 'yes' }],
    ['jti', { jti: undefined }],
  ])('refuses a malformed or missing %s', async (_name, over) => {
    expect(await verifyOrgPlaneToken(await planeToken(over), CFG, APP_AUD, fetchImpl)).toBeNull();
  });

  it('reports ent without superpipeline as verified-but-not-entitled (the 403 is the caller\'s)', async () => {
    const claims = await verifyOrgPlaneToken(await planeToken({ ent: ['agentpod'] }), CFG, APP_AUD, fetchImpl);
    expect(claims).not.toBeNull();
    expect(entitles(claims!)).toBe(false);
  });

  it('verifies offline once the key set is warm — zero network calls, even with the plane down', async () => {
    await verifyOrgPlaneToken(await planeToken(), CFG, APP_AUD, fetchImpl);
    calls = [];
    jwksUp = false;
    expect(await verifyOrgPlaneToken(await planeToken(), CFG, APP_AUD, fetchImpl)).not.toBeNull();
    expect(calls).toEqual([]);
  });

  it('refetches exactly once for an unknown kid, then refuses', async () => {
    await verifyOrgPlaneToken(await planeToken(), CFG, APP_AUD, fetchImpl);
    calls = [];
    const stranger = (await generateKeyPair('EdDSA')).privateKey;
    expect(await verifyOrgPlaneToken(await planeToken({}, { kid: 'rotated-in', key: stranger }), CFG, APP_AUD, fetchImpl)).toBeNull();
    expect(calls).toEqual([PLANE_JWKS]);
  });

  it('fetches the configured JWKS URL, not one derived from the issuer', async () => {
    const custom = { ...CFG, jwksUrl: `${PLANE}/keys` };
    const seen: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response((await planeKeys()).jwksBody, { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect(await verifyOrgPlaneToken(await planeToken(), custom, APP_AUD, f)).not.toBeNull();
    expect(seen).toEqual([`${PLANE}/keys`]);
  });

  it('does not let a plane token pass the hub verifier (no dual-accept by accident)', async () => {
    expect(await verifyHubToken(await planeToken(), { issuer: PLANE, audience: APP_AUD, fetch: fetchImpl })).toBeNull();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @superpipeline/api exec vitest run test/org-plane-verify.test.ts`
Expected: FAIL — `Cannot find module '../src/auth/org-plane'`.

- [ ] **Step 4: Add the env vars** (`apps/api/src/env.ts`, after `HUB_ISSUER` at line 24)

```ts
  /**
   * The Organization plane (accounts `2026-10-06-issuer-contract.md` §1). **`ORG_PLANE_ISSUER` is the
   * switch**: unset means this deployment verifies the hub's tokens exactly as before. Set means it
   * verifies the plane's tokens and refuses the hub's — there is no dual-accept. Set with any of
   * the other three missing or malformed fails closed (`orgPlaneMode` → `invalid`).
   */
  ORG_PLANE_ISSUER?: string;
  ORG_PLANE_JWKS_URL?: string;
  /** This deployment's resource, e.g. https://app.superpipeline.dev. MCP's is this plus `/mcp`. */
  ORG_PLANE_AUDIENCE?: string;
  /** Base for the plane's OAuth and token endpoints. */
  ORG_PLANE_URL?: string;
```

- [ ] **Step 5: Extract `verifyJws` in `hub-jwt.ts`**

Replace `VerifyOptions`-keyed caching with `JwsOptions`, and keep every existing comment that still describes the code. The changes:

```ts
export interface JwsOptions {
  issuer: string;
  /** Where the key set lives. The cache is keyed by this, not by the issuer. */
  jwksUrl: string;
  audience: string;
  /** Claims jose must find. The hub path asks for exp+iat; the plane path adds jti and sub. */
  requiredClaims: string[];
  fetch?: typeof fetch;
}

// cache and inflight: Map<jwksUrl, …> (was Map<issuer, …>)

function fetchFresh(opts: JwsOptions): Promise<CachedSet | null> {
  const existing = inflight.get(opts.jwksUrl);
  if (existing) return existing;
  const promise = (async (): Promise<CachedSet | null> => {
    const doFetch = opts.fetch ?? fetch;
    try {
      const res = await doFetch(opts.jwksUrl);
      // …unchanged body…
      cache.set(opts.jwksUrl, fresh);
      return fresh;
    } catch {
      return null;
    }
  })();
  inflight.set(opts.jwksUrl, promise);
  promise.finally(() => {
    if (inflight.get(opts.jwksUrl) === promise) inflight.delete(opts.jwksUrl);
  });
  return promise;
}

async function keySet(opts: JwsOptions, kid: string): Promise<CachedSet | null> {
  const now = Date.now();
  const cached = cache.get(opts.jwksUrl);
  // …rest unchanged…
}

/**
 * Header check, key lookup and signature/iss/aud/exp verification shared by every issuer this plane
 * trusts. Null for every failure. jose's `audience` option accepts a token whose `aud` is a string
 * equal to it OR an array containing it (contract §2).
 */
export async function verifyJws(token: string, opts: JwsOptions): Promise<JWTPayload | null> {
  if (!token) return null;
  // …the header/alg/kid block from the old verifyHubToken, unchanged…
  try {
    const set = await keySet(opts, kid);
    if (!set) return null;
    if (!hasKid(set, kid)) return null;
    const { payload } = await jwtVerify(token, set.verify, {
      issuer: opts.issuer,
      audience: opts.audience,
      requiredClaims: opts.requiredClaims,
      algorithms: ['EdDSA'],
    });
    return payload;
  } catch {
    return null;
  }
}

export async function verifyHubToken(token: string, opts: VerifyOptions): Promise<HubClaims | null> {
  const payload = await verifyJws(token, {
    issuer: opts.issuer,
    jwksUrl: `${opts.issuer}/api/auth/jwks`,
    audience: opts.audience,
    requiredClaims: ['exp', 'iat'],
    fetch: opts.fetch,
  });
  if (!payload) return null;
  const tenant = payload.tenant;
  if (typeof tenant !== 'string' || tenant === '') return null;
  const kind = payload.principalKind;
  if (kind !== 'human' && kind !== 'agent' && kind !== 'service') return null;
  if (typeof payload.sub !== 'string' || payload.sub === '') return null;
  return payload as HubClaims;
}
```

- [ ] **Step 6: Write `apps/api/src/auth/org-plane.ts`**

```ts
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
```

- [ ] **Step 7: Run the new test and the existing hub-verifier suites**

Run: `pnpm --filter @superpipeline/api exec vitest run test/org-plane-verify.test.ts test/hub-jwt.test.ts test/hub-jwt-audience.test.ts test/hub-claim-contract.test.ts`
Expected: all PASS. Then revert-proof two guards one at a time: delete `if (!ORG.test(p.org)) …` and confirm the `org` case goes red; change `cache.get(opts.jwksUrl)` back to issuer keying and confirm "fetches the configured JWKS URL" goes red. Restore both.

- [ ] **Step 8: Add the wrangler comment, then run the full suite and typecheck**

In `apps/api/wrangler.jsonc`, directly above `"vars": {`, add:

```jsonc
  // ORG_PLANE_ISSUER / ORG_PLANE_JWKS_URL / ORG_PLANE_AUDIENCE / ORG_PLANE_URL switch this deployment
  // to the Organization plane (src/auth/org-plane.ts). They are deliberately ABSENT until the P4
  // cutover: setting ORG_PLANE_ISSUER refuses every hub token. See docs/12-deploy.md.
```

Run: `pnpm --filter @superpipeline/api test && pnpm --filter @superpipeline/api typecheck`
Expected: PASS. Nothing reads `orgPlaneMode` yet, so production behaviour is unchanged.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/env.ts apps/api/src/auth/hub-jwt.ts apps/api/src/auth/org-plane.ts apps/api/test/helpers/org-plane.ts apps/api/test/org-plane-verify.test.ts apps/api/wrangler.jsonc
git commit -m "feat(api): verify Organization plane tokens behind ORG_PLANE_ISSUER

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Claim fixture parity

**Files:**
- Create: `apps/api/test/fixtures/org-plane-token-claims.json`
- Test: `apps/api/test/org-plane-claim-contract.test.ts`

**Interfaces:**
- Consumes: `verifyOrgPlaneToken`, `OrgPlaneConfig` (Task 1); `planeKeys`, `PLANE`, `PLANE_JWKS`, `APP_AUD`, `MCP_AUD` (Task 1 helper).
- Produces: the fixture file, which Task 4's tests also read for its three example tokens.

The plane's own fixture (`fixtures/ecosystem-identity/` in `accounts`, design §5.1) does not exist yet; P2 creates it. This fixture is contract §2 transcribed as data. It carries the version it was written against, so when P2 lands, a person diffs the two and bumps the pin. That is the same discipline `test/hub-claim-contract.test.ts` uses for the hub.

- [ ] **Step 1: Write the fixture**

```json
{
  "source": "accounts docs/superpowers/specs/2026-10-06-issuer-contract.md §2 (P2's fixtures/ecosystem-identity/ supersedes this once it exists)",
  "version": 1,
  "always": ["iss", "sub", "aud", "exp", "iat", "jti", "principalKind", "org", "ent", "mayDispatch", "mayGrantReach"],
  "conditional": {
    "scope": "exchange tokens: grant scopes; OAuth tokens: the OAuth scope string. Read only when principalKind is agent or service.",
    "act": "when delegated: { sub: prn_ }",
    "amr": "exchange tokens only: [device] | [exchange] | [service]",
    "email": "humans",
    "email_verified": "humans"
  },
  "ignored": ["client_id", "azp", "sid"],
  "removed": ["tenant"],
  "examples": {
    "human_oauth": {
      "sub": "prn_000000000000000000a1", "principalKind": "human", "org": "org_00000000000000000a01",
      "ent": ["agentpod", "superpipeline"], "mayDispatch": ["prn_000000000000000000a2"], "mayGrantReach": true,
      "scope": "openid profile email offline_access", "email": "person@example.com", "email_verified": true,
      "client_id": "superpipeline-web", "azp": "superpipeline-web", "sid": "s1"
    },
    "agent_exchange": {
      "sub": "prn_000000000000000000a2", "principalKind": "agent", "org": "org_00000000000000000a01",
      "ent": ["superpipeline"], "mayDispatch": [], "mayGrantReach": false,
      "scope": "evidence:read", "act": { "sub": "prn_000000000000000000a4" }, "amr": ["exchange"]
    },
    "service_exchange": {
      "sub": "prn_000000000000000000a3", "principalKind": "service", "org": "org_00000000000000000a01",
      "ent": ["superpipeline", "superwitness"], "mayDispatch": [], "mayGrantReach": false,
      "scope": "evidence:read", "amr": ["service"]
    }
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import fixture from './fixtures/org-plane-token-claims.json';
import { verifyOrgPlaneToken, type OrgPlaneConfig } from '../src/auth/org-plane';
import { __resetJwksCacheForTests } from '../src/auth/hub-jwt';
import { PLANE, PLANE_JWKS, APP_AUD, MCP_AUD, KID, planeKeys } from './helpers/org-plane';

/** Bump only after diffing against the plane's own fixture and fixing the consumer first. */
const FIXTURE_VERSION = 1;
const CFG: OrgPlaneConfig = { issuer: PLANE, jwksUrl: PLANE_JWKS, audience: APP_AUD, mcpAudience: MCP_AUD, url: PLANE };
const fetchImpl = (async () =>
  new Response((await planeKeys()).jwksBody, { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

async function sign(payload: Record<string, unknown>, drop?: string): Promise<string> {
  const { privateKey } = await planeKeys();
  const p: Record<string, unknown> = { jti: crypto.randomUUID(), ...payload };
  let t = new SignJWT(p).setProtectedHeader({ alg: 'EdDSA', kid: KID });
  if (drop !== 'iss') t = t.setIssuer(PLANE);
  if (drop !== 'aud') t = t.setAudience([APP_AUD, `${PLANE}/api/auth/oauth2/userinfo`]);
  if (drop !== 'iat') t = t.setIssuedAt();
  if (drop !== 'exp') t = t.setExpirationTime('5m');
  if (drop && drop in p) delete p[drop];
  return t.sign(privateKey);
}

beforeEach(() => __resetJwksCacheForTests());

describe('the plane claim contract, as superpipeline reads it', () => {
  it('pins the fixture version', () => {
    expect(fixture.version, 'contract fixture changed: diff it, fix org-plane.ts, then bump').toBe(FIXTURE_VERSION);
  });

  it.each(Object.entries(fixture.examples))('verifies the %s example verbatim', async (_name, example) => {
    const claims = await verifyOrgPlaneToken(await sign(example as Record<string, unknown>), CFG, APP_AUD, fetchImpl);
    expect(claims).not.toBeNull();
    for (const [k, v] of Object.entries(example)) expect(claims![k as keyof typeof claims]).toEqual(v);
  });

  it.each(fixture.always)('refuses a token missing the always-present claim %s', async (name) => {
    const token = await sign({ ...fixture.examples.human_oauth }, name);
    expect(await verifyOrgPlaneToken(token, CFG, APP_AUD, fetchImpl)).toBeNull();
  });

  it('never needs the removed tenant claim', async () => {
    expect(fixture.removed).toContain('tenant');
    expect('tenant' in fixture.examples.human_oauth).toBe(false);
  });
});
```

Note: `apps/api/tsconfig.json` must allow JSON imports. If `resolveJsonModule` is not on in `tsconfig.base.json`, add `"resolveJsonModule": true` to `apps/api/tsconfig.json` `compilerOptions` in this step.

- [ ] **Step 3: Run it**

Run: `pnpm --filter @superpipeline/api exec vitest run test/org-plane-claim-contract.test.ts`
Expected: PASS on first run if Task 1 is correct. That is acceptable here, because this task pins a contract rather than adding behaviour. Revert-proof it: remove `'jti'` from `requiredClaims` in `org-plane.ts`, then confirm "missing … jti" goes red. Restore it.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/fixtures/org-plane-token-claims.json apps/api/test/org-plane-claim-contract.test.ts apps/api/tsconfig.json
git commit -m "test(api): pin the Organization plane token claims as a fixture

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: One tenant per organization, and first sight

**Files:**
- Create: `apps/api/migrations/0017_org_plane_tenant_unique.sql`
- Modify: `apps/api/test/helpers/catalog.ts` (run 0017 in `setupCatalog`, guarded by `indexExists('tenants_org_plane_unique')`, the same way 0004 is run)
- Create: `apps/api/src/auth/org-tenancy.ts`
- Test: `apps/api/test/org-tenancy.test.ts`

**Interfaces:**
- Consumes: `ORG_PLANE_SOURCE`, `OrgPlaneClaims` (Task 1); the existing `findTenantByExternal`, `findUserByExternal`, `findUserByEmail`, `setUserExternalMapping`, `upsertUserByEmail` (`apps/api/src/db/catalog.ts`); `roleFor`, `Role` (`apps/api/src/db/members.ts`); `newId` (`apps/api/src/ids.ts`).
- Produces:
  - `export async function ensureOrgTenant(db: D1Database, org: string): Promise<string>`, which returns the `tnt_` id.
  - `export interface OrgHuman { userId: string; role: Role }`
  - `export async function provisionOrgHuman(db: D1Database, tenantId: string, claims: Pick<OrgPlaneClaims, 'sub' | 'email' | 'email_verified'>): Promise<OrgHuman | null>`

**Why a unique index now.** `tenants.external_id` is deliberately not unique for `agentpod` (migration 0002: many personal workspaces may link one fleet). An `org` is a workspace, not a fleet. Two tenants for one `org` would split a team's boards, and `findTenantByExternal`'s `.first()` would pick one arbitrarily. The index is partial, so it touches only `org-plane` rows, of which production has none today. That makes it safe to auto-apply on merge.

**Role on first sight.** The token carries no Superpipeline seat (design §4: "Product seats … stay in each product"). The first person to arrive in a new org tenant becomes `owner`; later people become `member`; existing memberships are never changed. This is decided in **one SQL statement**, so concurrent first requests cannot both see "no members". Whether seats should follow the plane's org role is an open question (see the end of this plan).

- [ ] **Step 1: Write the migration**

```sql
-- One local tenant per Organization-plane workspace (accounts issuer contract §2, "First sight").
--
-- Partial on purpose. `agentpod` mappings stay many-to-one (migration 0002's decision); only
-- `org-plane` rows are constrained, and none exist before the P4 cutover, so this applies cleanly
-- on the automatic deploy. `ensureOrgTenant` relies on it to make concurrent first sight create
-- exactly one row.
CREATE UNIQUE INDEX tenants_org_plane_unique ON tenants(external_id) WHERE external_source = 'org-plane';
```

- [ ] **Step 2: Write the failing test** (`apps/api/test/org-tenancy.test.ts`)

```ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { ensureOrgTenant, provisionOrgHuman } from '../src/auth/org-tenancy';
import { findTenantByExternal, findUserByExternal, setUserExternalMapping, upsertUserByEmail } from '../src/db/catalog';
import { roleFor } from '../src/db/members';

beforeAll(setupCatalog);

const org = (n: number) => `org_${n.toString(16).padStart(20, '0')}`;
const prn = (n: number) => `prn_${n.toString(16).padStart(20, '0')}`;

describe('ensureOrgTenant — first sight', () => {
  it('creates one tenant mapped to the org, and returns it again on the next sight', async () => {
    const a = await ensureOrgTenant(env.DB, org(0x101));
    const b = await ensureOrgTenant(env.DB, org(0x101));
    expect(a).toMatch(/^tnt_/);
    expect(b).toBe(a);
    expect(await findTenantByExternal(env.DB, 'org-plane', org(0x101))).toBe(a);
  });

  it('creates exactly ONE tenant when a board view fires many first requests at once', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, () => ensureOrgTenant(env.DB, org(0x102))));
    expect(new Set(ids).size).toBe(1);
    const { results } = await env.DB.prepare(`SELECT id FROM tenants WHERE external_source = 'org-plane' AND external_id = ?`)
      .bind(org(0x102)).all();
    expect(results).toHaveLength(1);
  });

  it('never reuses an agentpod-mapped tenant whose fleet id happens to equal nothing here', async () => {
    await env.DB.prepare(`INSERT INTO tenants (id, slug, name, external_source, external_id) VALUES ('tnt_fleetonly', 'fleetonly', 'F', 'agentpod', 'fleet_0123456789abcdef0123')`).run();
    const t = await ensureOrgTenant(env.DB, org(0x103));
    expect(t).not.toBe('tnt_fleetonly');
  });
});

describe('provisionOrgHuman', () => {
  it('creates and maps a new person, who becomes owner of an empty org tenant', async () => {
    const t = await ensureOrgTenant(env.DB, org(0x201));
    const h = await provisionOrgHuman(env.DB, t, { sub: prn(0x201), email: 'First@Example.com', email_verified: true });
    expect(h?.role).toBe('owner');
    const mapped = await findUserByExternal(env.DB, 'org-plane', prn(0x201));
    expect(mapped?.id).toBe(h?.userId);
    expect(mapped?.email).toBe('first@example.com');
  });

  it('makes the second person a member, and never demotes or promotes an existing seat', async () => {
    const t = await ensureOrgTenant(env.DB, org(0x202));
    await provisionOrgHuman(env.DB, t, { sub: prn(0x202), email: 'a202@example.com', email_verified: true });
    const second = await provisionOrgHuman(env.DB, t, { sub: prn(0x203), email: 'b202@example.com', email_verified: true });
    expect(second?.role).toBe('member');
    await env.DB.prepare(`UPDATE memberships SET role = 'admin' WHERE tenant_id = ? AND user_id = ?`).bind(t, second!.userId).run();
    expect((await provisionOrgHuman(env.DB, t, { sub: prn(0x203) }))?.role).toBe('admin');
  });

  it('gives exactly one owner when two new people arrive at the same instant', async () => {
    const t = await ensureOrgTenant(env.DB, org(0x204));
    const [x, y] = await Promise.all([
      provisionOrgHuman(env.DB, t, { sub: prn(0x204), email: 'x204@example.com', email_verified: true }),
      provisionOrgHuman(env.DB, t, { sub: prn(0x205), email: 'y204@example.com', email_verified: true }),
    ]);
    expect([x?.role, y?.role].sort()).toEqual(['member', 'owner']);
  });

  it('adopts an unmapped GitHub-created user by verified address, exactly once', async () => {
    const gh = await upsertUserByEmail(env.DB, { email: 'Adopt.Me@Example.com', name: 'Adopt' });
    const t = await ensureOrgTenant(env.DB, org(0x206));
    const h = await provisionOrgHuman(env.DB, t, { sub: prn(0x206), email: 'adopt.me@example.com', email_verified: true });
    expect(h?.userId).toBe(gh.id);
  });

  it('does NOT adopt when the address is unverified, and creates nothing', async () => {
    await upsertUserByEmail(env.DB, { email: 'unverified@example.com', name: null });
    const t = await ensureOrgTenant(env.DB, org(0x207));
    expect(await provisionOrgHuman(env.DB, t, { sub: prn(0x207), email: 'unverified@example.com', email_verified: false })).toBeNull();
    expect(await provisionOrgHuman(env.DB, t, { sub: prn(0x208), email: 'nobody-yet@example.com', email_verified: 'true' as unknown as boolean })).toBeNull();
    expect(await findUserByExternal(env.DB, 'org-plane', prn(0x207))).toBeNull();
  });

  it('refuses — never captures — an account still mapped to the hub (re-pointed only by the P4 script)', async () => {
    const hubUser = await upsertUserByEmail(env.DB, { email: 'hub-linked@example.com', name: null });
    await setUserExternalMapping(env.DB, hubUser.id, { externalSource: 'agentpod', externalId: 'BetterAuthId123' });
    const t = await ensureOrgTenant(env.DB, org(0x209));
    expect(await provisionOrgHuman(env.DB, t, { sub: prn(0x209), email: 'hub-linked@example.com', email_verified: true })).toBeNull();
    expect(await roleFor(env.DB, t, hubUser.id)).toBeNull();
  });

  it('resolves an already-mapped person by sub alone, with no email claim at all', async () => {
    const t = await ensureOrgTenant(env.DB, org(0x20a));
    const first = await provisionOrgHuman(env.DB, t, { sub: prn(0x20a), email: 'sub-only@example.com', email_verified: true });
    expect((await provisionOrgHuman(env.DB, t, { sub: prn(0x20a) }))?.userId).toBe(first?.userId);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @superpipeline/api exec vitest run test/org-tenancy.test.ts`
Expected: FAIL — module `../src/auth/org-tenancy` not found.

- [ ] **Step 4: Run 0017 in the test catalog** (`apps/api/test/helpers/catalog.ts`)

Add the import `import orgPlaneTenantUnique from '../../migrations/0017_org_plane_tenant_unique.sql?raw';`. At the end of `setupCatalog`, add:

```ts
  if (!(await indexExists('tenants_org_plane_unique'))) {
    for (const s of statementsOf(orgPlaneTenantUnique)) await env.DB.prepare(s).run();
  }
```

- [ ] **Step 5: Write `apps/api/src/auth/org-tenancy.ts`**

```ts
/**
 * Where a plane token lands here: the tenant its `org` maps to (created on first sight), and the
 * local user its `sub` maps to (adopted or created once, then found by `sub` forever).
 *
 * Adoption mirrors `hub-oauth.ts` `signInFromHubToken` steps 1–3 and keeps both of its guards:
 * `email_verified === true`, and "the candidate has no mapping yet". A row still mapped to the hub
 * (`agentpod`) is NOT adoptable — the P4 re-point script moves it, so nothing here has to guess.
 */
import { newId } from '../ids';
import {
  findTenantByExternal,
  findUserByEmail,
  findUserByExternal,
  setUserExternalMapping,
  upsertUserByEmail,
  type UserRecord,
} from '../db/catalog';
import { roleFor, type Role } from '../db/members';
import { ORG_PLANE_SOURCE, type OrgPlaneClaims } from './org-plane';

export async function ensureOrgTenant(db: D1Database, org: string): Promise<string> {
  const existing = await findTenantByExternal(db, ORG_PLANE_SOURCE, org);
  if (existing) return existing;
  const id = newId('tnt');
  // OR IGNORE + the partial unique index (migration 0017): a concurrent first sight loses quietly
  // and reads the winner's row below.
  await db
    .prepare(`INSERT OR IGNORE INTO tenants (id, slug, name, external_source, external_id) VALUES (?, ?, 'Workspace', ?, ?)`)
    .bind(id, `ws-${org.slice(4, 14)}-${id.slice(-6)}`, ORG_PLANE_SOURCE, org)
    .run();
  const after = await findTenantByExternal(db, ORG_PLANE_SOURCE, org);
  if (!after) throw new Error('first sight could not create the workspace tenant');
  return after;
}

export interface OrgHuman {
  userId: string;
  role: Role;
}

export async function provisionOrgHuman(
  db: D1Database,
  tenantId: string,
  claims: Pick<OrgPlaneClaims, 'sub' | 'email' | 'email_verified'>,
): Promise<OrgHuman | null> {
  let user: UserRecord | null = await findUserByExternal(db, ORG_PLANE_SOURCE, claims.sub);
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';

  if (!user && email !== '' && claims.email_verified === true) {
    const candidate = await findUserByEmail(db, email);
    if (candidate && !candidate.externalId) {
      await setUserExternalMapping(db, candidate.id, { externalSource: ORG_PLANE_SOURCE, externalId: claims.sub });
      user = candidate;
    } else if (!candidate) {
      const created = await upsertUserByEmail(db, { email, name: null });
      await setUserExternalMapping(db, created.id, { externalSource: ORG_PLANE_SOURCE, externalId: claims.sub });
      user = created;
    }
  }
  if (!user) return null;

  // One statement decides owner-vs-member, so two first arrivals cannot both see an empty tenant.
  await db
    .prepare(
      `INSERT OR IGNORE INTO memberships (id, tenant_id, user_id, role)
       SELECT ?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM memberships WHERE tenant_id = ?) THEN 'member' ELSE 'owner' END`,
    )
    .bind(newId('mbr'), tenantId, user.id, tenantId)
    .run();
  const role = await roleFor(db, tenantId, user.id);
  return role ? { userId: user.id, role } : null;
}
```

- [ ] **Step 6: Run the tests, then revert-proof**

Run: `pnpm --filter @superpipeline/api exec vitest run test/org-tenancy.test.ts`
Expected: PASS. Then try each of these, one at a time, and confirm the named test goes red. Restore after each.
- Drop `&& !candidate.externalId`: the "refuses — never captures" test should fail.
- Change `=== true` to a truthiness test: the `'true'` string case should fail.
- Delete the 0017 index from the helper: the "exactly ONE tenant" test should fail.

  If the single-statement CASE does not make the "exactly one owner" test fail when you replace it with a read-then-insert, record that in the PR: D1 may serialise the two calls anyway. The statement stays atomic regardless.

- [ ] **Step 7: Full suite, then commit**

Run: `pnpm --filter @superpipeline/api test`
Expected: PASS.

```bash
git add apps/api/migrations/0017_org_plane_tenant_unique.sql apps/api/test/helpers/catalog.ts apps/api/src/auth/org-tenancy.ts apps/api/test/org-tenancy.test.ts
git commit -m "feat(api): one tenant per organization, created on first sight

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Deploy check after merge: `pnpm --filter @superpipeline/api exec wrangler d1 execute superpipeline-catalog --remote --command "SELECT name FROM sqlite_master WHERE name = 'tenants_org_plane_unique'"` should return one row.

---

### Task 4: REST resolvers switch to the plane, and the entitlement 403

**Files:**
- Create: `apps/api/src/auth/org-plane-resolve.ts`
- Modify: `apps/api/src/auth/resolve.ts:222-224, 293-295, 358-360` (a plane branch at the top of each of the three functions)
- Modify: `apps/api/src/index.ts:448-450` (entitlement gate after `/health`), `apps/api/src/index.ts:550-553` (`PATCH /v1/tenant` refused in plane mode)
- Modify: `apps/api/src/db/catalog.ts:479-489` (`userExternalIds` reads both sources)
- Test: `apps/api/test/org-plane-rest.test.ts`

**Interfaces:**
- Consumes:
  - from Task 1: `orgPlaneMode`, `verifyOrgPlaneToken`, `entitles`, `OrgPlaneConfig`, `OrgPlaneClaims`, `ORG_PLANE_SOURCE`;
  - from Task 3: `ensureOrgTenant`, `provisionOrgHuman`;
  - existing: `findAgentByExternal`, `findTenantByExternal`, and `UserPrincipal` / `AgentPrincipal` / `ServicePrincipal` (type-only import from `resolve.ts`).
- Produces (`org-plane-resolve.ts`):
  - `export function bearerOf(request: Request): string | null`
  - `export async function planeClaimsFor(request: Request, cfg: OrgPlaneConfig, audience: string): Promise<OrgPlaneClaims | null>`, memoised per `(request, audience)` in a `WeakMap`, so the gate and the resolver verify once.
  - `export async function resolvePlaneUser(request: Request, env: Env, cfg: OrgPlaneConfig): Promise<UserPrincipal | null>`
  - `export async function resolvePlaneAgent(request: Request, env: Env, cfg: OrgPlaneConfig): Promise<AgentPrincipal | null>`
  - `export async function resolvePlaneService(request: Request, env: Env, cfg: OrgPlaneConfig): Promise<ServicePrincipal | null>`
  - `export async function entitlementRefusal(request: Request, env: Env): Promise<Response | null>`
  - `export function productNotEnabled(org: string): Response`

The three hub resolvers are called from about twenty sites in `index.ts` (`:330`, `:337`, `:397`, `:518`, `:708`, `:1198`, `:1288`, `:1303`, `:1747`, `:1776`, …). Branching **inside** them keeps every call site unchanged, so no route can be missed.

- [ ] **Step 1: Write the failing test** (`apps/api/test/org-plane-rest.test.ts`)

```ts
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { setupCatalog } from './helpers/catalog';
import { withOrgPlane, planeToken, planeEnv, ORG, OTHER_ORG, HUMAN, AGENT, SERVICE } from './helpers/org-plane';
import { withIssuer } from './helpers/hub-issuer';
import { resolveHubAgent, resolveHubService, resolveHubUser } from '../src/auth/resolve';
import { createAgent, setAgentExternalMapping, findTenantByExternal } from '../src/db/catalog';
import { ensureOrgTenant } from '../src/auth/org-tenancy';
import { __resetJwksCacheForTests } from '../src/auth/hub-jwt';

beforeAll(setupCatalog);

const get = (path: string, token: string) =>
  SELF.fetch(`https://api.test${path}`, { headers: { Authorization: `Bearer ${token}` } });

/** A hub token, as production issues today, for the no-dual-accept and rollback checks. */
const HUB = 'https://hub.test';
async function hubFixture() {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  const jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'hub-kid' }] });
  const token = await new SignJWT({ sub: 'hubsub_rest', principalKind: 'human', tenant: 'fleet_0000000000000000rest' })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'hub-kid' })
    .setIssuer(HUB).setAudience([HUB, 'https://api.test']).setIssuedAt().setExpirationTime('5m')
    .sign(pair.privateKey);
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name, external_source, external_id) VALUES ('tnt_hubrest', 'hubrest', 'H', 'agentpod', 'fleet_0000000000000000rest')`).run();
  return { token, jwksBody };
}

describe('plane mode — a human bearer', () => {
  it('lands in the org tenant, created on first sight, as its first owner', async () => {
    await withOrgPlane(async () => {
      const res = await get('/v1/boards', await planeToken());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ boards: [] });
      const tenant = await findTenantByExternal(env.DB, 'org-plane', ORG);
      expect(tenant).toMatch(/^tnt_/);
      const u = await resolveHubUser(new Request('https://api.test/v1/boards', { headers: { Authorization: `Bearer ${await planeToken()}` } }), planeEnv());
      expect(u).toMatchObject({ tenantId: tenant, role: 'owner', mayDispatch: [] });
    });
  });

  it('carries mayDispatch from the token, never from a stored copy', async () => {
    await withOrgPlane(async () => {
      const req = new Request('https://api.test/x', { headers: { Authorization: `Bearer ${await planeToken({ mayDispatch: [AGENT] })}` } });
      expect((await resolveHubUser(req, planeEnv()))?.mayDispatch).toEqual([AGENT]);
    });
  });

  it('answers 403 product_not_enabled — with the org — when ent lacks superpipeline', async () => {
    await withOrgPlane(async () => {
      const res = await get('/v1/boards', await planeToken({ org: OTHER_ORG, ent: ['agentpod'] }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'product_not_enabled', org: OTHER_ORG });
      // …and first sight did not run for an org that is not entitled.
      expect(await findTenantByExternal(env.DB, 'org-plane', OTHER_ORG)).toBeNull();
    });
  });

  it('refuses a token for the MCP audience on REST (401, not 403)', async () => {
    await withOrgPlane(async () => {
      expect((await get('/v1/boards', await planeToken({}, { aud: 'https://api.test/mcp' }))).status).toBe(401);
    });
  });

  it('refuses a token signed by a stranger', async () => {
    await withOrgPlane(async () => {
      const stranger = (await generateKeyPair('EdDSA')).privateKey;
      expect((await get('/v1/boards', await planeToken({}, { kid: 'nope', key: stranger }))).status).toBe(401);
    });
  });
});

describe('no dual-accept, and rollback', () => {
  it('refuses a valid HUB token while plane mode is on, and accepts it again once plane mode is off', async () => {
    const { token, jwksBody } = await hubFixture();
    await withIssuer(HUB, jwksBody, async () => {
      __resetJwksCacheForTests();
      expect((await get('/v1/boards', token)).status, 'hub mode accepts the hub token').toBe(200);
      await withOrgPlane(async () => {
        expect((await get('/v1/boards', token)).status, 'plane mode refuses it').toBe(401);
      });
      __resetJwksCacheForTests();
      expect((await get('/v1/boards', token)).status, 'rollback accepts it again').toBe(200);
    });
  });

  it('refuses a plane token while plane mode is off', async () => {
    expect((await get('/v1/boards', await planeToken())).status).toBe(401);
  });

  it('fails closed — plane AND hub refused — when ORG_PLANE_ISSUER is set but the rest is missing', async () => {
    const { token } = await hubFixture();
    const half = planeEnv({ ORG_PLANE_JWKS_URL: undefined });
    const hubReq = new Request('https://api.test/v1/boards', { headers: { Authorization: `Bearer ${token}` } });
    const planeReq = new Request('https://api.test/v1/boards', { headers: { Authorization: `Bearer ${await planeToken()}` } });
    expect(await resolveHubUser(hubReq, { ...half, HUB_ISSUER: HUB } as typeof half)).toBeNull();
    expect(await resolveHubUser(planeReq, half)).toBeNull();
  });
});

describe('plane mode — agent and service bearers', () => {
  it('resolves an agent token to the local agent mapped by its prn_, in the org tenant', async () => {
    await withOrgPlane(async () => {
      const tenantId = await ensureOrgTenant(env.DB, ORG);
      const agent = await createAgent(env.DB, tenantId, { name: 'Researcher', capabilities: ['research'] });
      await setAgentExternalMapping(env.DB, tenantId, agent.id, { externalSource: 'org-plane', externalId: AGENT });
      const req = new Request('https://api.test/x', { headers: { Authorization: `Bearer ${await planeToken({ sub: AGENT, principalKind: 'agent', mayDispatch: [] })}` } });
      const resolved = await resolveHubAgent(req, planeEnv());
      expect(resolved).toMatchObject({ tenantId, agentId: agent.id, capabilities: ['research'], externalId: AGENT, mayDispatch: [] });
    });
  });

  it('refuses an agent token whose org is not the tenant its row sits in', async () => {
    await withOrgPlane(async () => {
      const req = new Request('https://api.test/x', { headers: { Authorization: `Bearer ${await planeToken({ sub: AGENT, principalKind: 'agent', org: OTHER_ORG })}` } });
      expect(await resolveHubAgent(req, planeEnv())).toBeNull();
    });
  });

  it('never lets a human token act as an agent, or the reverse', async () => {
    await withOrgPlane(async () => {
      const human = new Request('https://api.test/x', { headers: { Authorization: `Bearer ${await planeToken()}` } });
      const agent = new Request('https://api.test/x', { headers: { Authorization: `Bearer ${await planeToken({ sub: AGENT, principalKind: 'agent' })}` } });
      expect(await resolveHubAgent(human, planeEnv())).toBeNull();
      expect(await resolveHubUser(agent, planeEnv())).toBeNull();
    });
  });

  it('resolves a service token with its grant scopes', async () => {
    await withOrgPlane(async () => {
      const tenantId = await ensureOrgTenant(env.DB, ORG);
      const req = new Request('https://api.test/x', { headers: { Authorization: `Bearer ${await planeToken({ sub: SERVICE, principalKind: 'service', scope: 'evidence:read', email: undefined, email_verified: undefined })}` } });
      expect(await resolveHubService(req, planeEnv())).toEqual({ principalId: SERVICE, tenantId, scopes: ['evidence:read'] });
    });
  });
});

describe('plane mode — the fleet link cannot overwrite the org mapping', () => {
  it('PATCH /v1/tenant answers 409 in plane mode', async () => {
    await withOrgPlane(async () => {
      const res = await SELF.fetch('https://api.test/v1/tenant', {
        method: 'PATCH',
        headers: { 'X-Tenant-Id': 'tnt_patch', 'X-User-Id': 'usr_p', 'Content-Type': 'application/json' },
        body: JSON.stringify({ externalId: 'fleet_0123456789abcdef0123' }),
      });
      expect(res.status).toBe(409);
    });
  });
});

describe('evidence ids for re-pointed users', () => {
  it('principalIdsFor maps a usr_ mapped to org-plane to its prn_', async () => {
    const { principalIdsFor, upsertUserByEmail, setUserExternalMapping } = await import('../src/db/catalog');
    const u = await upsertUserByEmail(env.DB, { email: 'evidence@example.com', name: null });
    await setUserExternalMapping(env.DB, u.id, { externalSource: 'org-plane', externalId: HUMAN.replace('a1', 'e1') });
    expect((await principalIdsFor(env.DB, 'tnt_any', [u.id])).get(u.id)).toBe(HUMAN.replace('a1', 'e1'));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @superpipeline/api exec vitest run test/org-plane-rest.test.ts`
Expected: FAIL. In plane mode `/v1/boards` answers 401, because `resolveHubUser` still reads `HUB_ISSUER`.

- [ ] **Step 3: Write `apps/api/src/auth/org-plane-resolve.ts`**

```ts
/**
 * Plane-mode resolution: the three siblings of `resolveHubUser` / `resolveHubAgent` /
 * `resolveHubService`, with the same refusals, keyed by `org` instead of `tenant`.
 */
import type { Env } from '../env';
import type { UserPrincipal, AgentPrincipal, ServicePrincipal } from './resolve';
import { findAgentByExternal, findTenantByExternal } from '../db/catalog';
import { entitles, orgPlaneMode, verifyOrgPlaneToken, ORG_PLANE_SOURCE, type OrgPlaneClaims, type OrgPlaneConfig } from './org-plane';
import { ensureOrgTenant, provisionOrgHuman } from './org-tenancy';

export function bearerOf(request: Request): string | null {
  const m = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

/** One verify per (request, audience): the entitlement gate and the resolver share it. */
const memo = new WeakMap<Request, Map<string, Promise<OrgPlaneClaims | null>>>();

export function planeClaimsFor(request: Request, cfg: OrgPlaneConfig, audience: string): Promise<OrgPlaneClaims | null> {
  const token = bearerOf(request);
  // `spa_` is superpipeline's own credential and never a JWT; a value without two dots is not one either.
  if (!token || token.startsWith('spa_') || token.split('.').length !== 3) return Promise.resolve(null);
  let byAud = memo.get(request);
  if (!byAud) memo.set(request, (byAud = new Map()));
  let p = byAud.get(audience);
  if (!p) byAud.set(audience, (p = verifyOrgPlaneToken(token, cfg, audience)));
  return p;
}

export function productNotEnabled(org: string): Response {
  return Response.json({ error: 'product_not_enabled', org }, { status: 403 });
}

/** The contract §2 refusal, before any route runs. Null when it does not apply. */
export async function entitlementRefusal(request: Request, env: Env): Promise<Response | null> {
  const mode = orgPlaneMode(env);
  if (mode.kind !== 'on') return null;
  const path = new URL(request.url).pathname;
  const audience = path === '/mcp' ? mode.cfg.mcpAudience : mode.cfg.audience;
  const claims = await planeClaimsFor(request, mode.cfg, audience);
  return claims && !entitles(claims) ? productNotEnabled(claims.org) : null;
}

export async function resolvePlaneUser(request: Request, env: Env, cfg: OrgPlaneConfig): Promise<UserPrincipal | null> {
  const claims = await planeClaimsFor(request, cfg, cfg.audience);
  if (!claims || !entitles(claims) || claims.principalKind !== 'human') return null;
  const tenantId = await ensureOrgTenant(env.DB, claims.org);
  const human = await provisionOrgHuman(env.DB, tenantId, claims);
  if (!human) {
    // Logged without claims: the useful fact is that a verified person could not be placed.
    console.warn('org-plane: a verified human could not be provisioned (unverified address, or an address held by a still-hub-mapped account)');
    return null;
  }
  return { userId: human.userId, tenantId, role: human.role, mayDispatch: claims.mayDispatch };
}

export async function resolvePlaneAgent(request: Request, env: Env, cfg: OrgPlaneConfig): Promise<AgentPrincipal | null> {
  const claims = await planeClaimsFor(request, cfg, cfg.audience);
  if (!claims || !entitles(claims) || claims.principalKind !== 'agent') return null;
  const found = await findAgentByExternal(env.DB, ORG_PLANE_SOURCE, claims.sub);
  if (!found) return null;
  const tenantId = await findTenantByExternal(env.DB, ORG_PLANE_SOURCE, claims.org);
  if (!tenantId || tenantId !== found.tenantId) return null;
  return {
    tenantId: found.tenantId,
    agentId: found.agentId,
    capabilities: found.capabilities,
    concurrency: found.concurrency,
    externalId: claims.sub,
    mayDispatch: claims.mayDispatch,
    queueing: {
      ownerUserId: found.ownerUserId,
      mayQueueTo: found.mayQueueTo,
      queueCeilingPerHour: found.queueCeilingPerHour,
      boardCeilingPerDay: found.boardCeilingPerDay,
    },
  };
}

export async function resolvePlaneService(request: Request, env: Env, cfg: OrgPlaneConfig): Promise<ServicePrincipal | null> {
  const claims = await planeClaimsFor(request, cfg, cfg.audience);
  if (!claims || !entitles(claims) || claims.principalKind !== 'service') return null;
  const tenantId = await findTenantByExternal(env.DB, ORG_PLANE_SOURCE, claims.org);
  if (!tenantId) return null;
  const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter((s) => s !== '') : [];
  return { principalId: claims.sub, tenantId, scopes };
}
```

- [ ] **Step 4: Branch the three hub resolvers** (`apps/api/src/auth/resolve.ts`)

Add the imports `import { orgPlaneMode } from './org-plane';` and `import { resolvePlaneUser, resolvePlaneAgent, resolvePlaneService } from './org-plane-resolve';`. Then make each function's first lines look like this (shown for `resolveHubUser` at `:222`; do the same at `:293` with `resolvePlaneAgent` and at `:358` with `resolvePlaneService`):

```ts
export async function resolveHubUser(request: Request, env: Env): Promise<UserPrincipal | null> {
  // The Organization plane replaces the hub; it does not join it (contract §1, no dual-accept).
  // `invalid` — the switch set, the rest missing — refuses everything rather than fall back.
  const plane = orgPlaneMode(env);
  if (plane.kind === 'on') return resolvePlaneUser(request, env, plane.cfg);
  if (plane.kind === 'invalid') return null;

  const issuer = env.HUB_ISSUER;
  // …unchanged…
```

- [ ] **Step 5: Gate and guard in `apps/api/src/index.ts`**

Add the import `import { entitlementRefusal } from './auth/org-plane-resolve';` and `import { orgPlaneMode } from './auth/org-plane';`. Directly after the `/health` block (`:448-450`), add:

```ts
    // Contract §2: a plane token whose `ent` lacks superpipeline is told so, by name, before any
    // route can turn it into a generic 401/403. Inert unless ORG_PLANE_ISSUER is set.
    const notEnabled = await entitlementRefusal(request, env);
    if (notEnabled) return notEnabled;
```

In `PATCH /v1/tenant`, immediately after `if (request.method !== 'PATCH') …` (`:559`), add:

```ts
        // In plane mode this workspace IS an org-plane mapping; writing a fleet over it would
        // orphan it, and the next token would create a fresh tenant by first sight.
        if (orgPlaneMode(env).kind !== 'off') {
          return Response.json({ error: 'this workspace is managed by the organization plane' }, { status: 409 });
        }
```

- [ ] **Step 6: `userExternalIds` reads both sources** (`apps/api/src/db/catalog.ts:485`)

```ts
    .prepare(`SELECT id, external_id FROM users WHERE external_source IN ('agentpod', 'org-plane') AND id IN (${ids.map(() => '?').join(',')})`)
```

Update the doc comment above it from "source `agentpod`" to "source `agentpod` or `org-plane` (an org-plane id is always a `prn_`)".

- [ ] **Step 7: Run, revert-proof, and run everything**

Run: `pnpm --filter @superpipeline/api exec vitest run test/org-plane-rest.test.ts`
Expected: PASS. Then revert-proof, one at a time:
- Remove the `invalid` early return in `resolveHubUser`: the "fails closed" test should go red.
- Remove the gate in `index.ts`: the 403 test should go red (it becomes 401).
- Drop `tenantId !== found.tenantId`: the "org is not the tenant" test should go red.

Run: `pnpm --filter @superpipeline/api test && pnpm --filter @superpipeline/api typecheck`
Expected: PASS. Every existing hub-token test passes unchanged, because plane mode is off.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/auth/org-plane-resolve.ts apps/api/src/auth/resolve.ts apps/api/src/index.ts apps/api/src/db/catalog.ts apps/api/test/org-plane-rest.test.ts
git commit -m "feat(api): resolve plane tokens by org, with product_not_enabled and no dual-accept

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: MCP accepts plane tokens and points clients at the plane

**Files:**
- Modify: `apps/api/src/auth/org-plane-resolve.ts` (add `resolvePlaneMcp`)
- Modify: `apps/api/src/mcp/auth.ts:34-63` (plane branch), `:81-102` (challenge and metadata take `env`)
- Modify: `apps/api/src/index.ts:469-478` (serve both RFC 9728 paths; pass `env`)
- Modify: `apps/api/wrangler.jsonc:114` (`run_worker_first` gains the metadata paths)
- Modify: `docs/05-integration-surfaces.md` (the "/mcp is a Resource Server shell" section: describe plane mode)
- Test: `apps/api/test/mcp-org-plane.test.ts`

**Interfaces:**
- Consumes:
  - from Task 4: `planeClaimsFor`;
  - from Task 3: `ensureOrgTenant`, `provisionOrgHuman`;
  - from Task 1: `orgPlaneMode`, `entitles`;
  - existing: `effectiveCapabilities` (`apps/api/src/db/implications.ts`) and `McpAuth` (`apps/api/src/mcp/tools.ts:18`).
- Produces:
  - `export async function resolvePlaneMcp(request: Request, env: Env, cfg: OrgPlaneConfig): Promise<McpAuth | null>`
  - `export function unauthorized(request: Request, env: Env): Response`
  - `export function protectedResourceMetadata(request: Request, env: Env, path: string): Response | null`, which returns null for a path it does not serve
  - `export const MCP_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'`
  - `export function metadataUrlFor(resource: string): string`, which builds the RFC 9728 §3.1 URL: origin + well-known + resource path

**Discovery.** Both metadata documents list `authorization_servers: [cfg.issuer]`, the root issuer. An MCP client then fetches `{issuer}/.well-known/oauth-authorization-server` (RFC 8414 for an issuer with no path), which the P2 plan serves at the root. The test below pins `[PLANE]`, the root, and asserts no `/api/auth` suffix appears.

**What a principal gets over MCP in plane mode.**
- An `agent` token is the agent, exactly as `resolvePlaneAgent` resolves it. Capabilities come from its own row, and `scopes: null`, the same as today's hub agent token on REST.
- A `human` token (an MCP client such as Claude Code, after consent at the plane) is provisioned like a REST human. It gets `scopes: []` and `capabilities: []`. `TOOL_SCOPE` registration therefore offers only the unscoped read tools; no claim or run verbs are offered. That is enough for the design §9 end-to-end check ("an MCP client registering and calling Superpipeline"). A richer human tool set is an open question.
- A `service` token is refused.

- [ ] **Step 1: Write the failing test** (`apps/api/test/mcp-org-plane.test.ts`)

```ts
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair } from 'jose';
import { setupCatalog } from './helpers/catalog';
import { withOrgPlane, planeToken, ORG, OTHER_ORG, AGENT, PLANE, MCP_AUD, APP_AUD } from './helpers/org-plane';
import { createAgent, createAgentToken, setAgentExternalMapping } from '../src/db/catalog';
import { ensureOrgTenant } from '../src/auth/org-tenancy';

beforeAll(setupCatalog);

/**
 * The MCP surface end to end against a locally generated Ed25519 plane: discovery, challenge,
 * and a JSON-RPC call — the path a real client (Claude Code) walks, minus the browser consent.
 */
const rpc = (token: string | null, method = 'tools/list') =>
  SELF.fetch('https://api.test/mcp', {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
  });

async function toolNames(res: Response): Promise<string[]> {
  const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
  return body.result.tools.map((t) => t.name);
}

describe('MCP discovery in plane mode', () => {
  it('challenges with resource_metadata naming the /mcp metadata document', async () => {
    await withOrgPlane(async () => {
      const res = await rpc(null);
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe(
        'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp"',
      );
    });
  });

  it('serves RFC 9728 metadata for /mcp that points at the plane', async () => {
    await withOrgPlane(async () => {
      const meta = (await (await SELF.fetch('https://api.test/.well-known/oauth-protected-resource/mcp')).json()) as Record<string, unknown>;
      expect(meta.resource).toBe(MCP_AUD);
      expect(meta.authorization_servers).toEqual([PLANE]);
      expect(JSON.stringify(meta)).not.toContain('/api/auth');
      expect(meta.bearer_methods_supported).toEqual(['header']);
    });
  });

  it('describes the app itself at the root metadata path', async () => {
    await withOrgPlane(async () => {
      const meta = (await (await SELF.fetch('https://api.test/.well-known/oauth-protected-resource')).json()) as Record<string, unknown>;
      expect(meta.resource).toBe(APP_AUD);
      expect(meta.authorization_servers).toEqual([PLANE]);
    });
  });

  it('leaves discovery exactly as it was when plane mode is off', async () => {
    const meta = (await (await SELF.fetch('https://api.test/.well-known/oauth-protected-resource')).json()) as Record<string, unknown>;
    expect(meta.authorization_servers).toEqual(['https://api.test']);
    expect((await rpc(null)).headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource"',
    );
  });
});

describe('MCP calls in plane mode', () => {
  it('an agent token for the MCP audience works, with the claim verb offered', async () => {
    await withOrgPlane(async () => {
      const tenantId = await ensureOrgTenant(env.DB, ORG);
      const agent = await createAgent(env.DB, tenantId, { name: 'Builder', capabilities: ['build'] });
      await setAgentExternalMapping(env.DB, tenantId, agent.id, { externalSource: 'org-plane', externalId: AGENT });
      const res = await rpc(await planeToken({ sub: AGENT, principalKind: 'agent' }, { aud: [MCP_AUD, `${PLANE}/api/auth/oauth2/userinfo`] }));
      expect(res.status).toBe(200);
      expect(await toolNames(res)).toContain('superpipeline_claim_card');
    });
  });

  it('a human token works and is offered reads only', async () => {
    await withOrgPlane(async () => {
      const res = await rpc(await planeToken({}, { aud: MCP_AUD }));
      expect(res.status).toBe(200);
      const names = await toolNames(res);
      expect(names).toContain('superpipeline_list_work');
      expect(names).not.toContain('superpipeline_claim_card');
    });
  });

  it('refuses a token for the app audience at /mcp', async () => {
    await withOrgPlane(async () => {
      expect((await rpc(await planeToken({}, { aud: APP_AUD }))).status).toBe(401);
    });
  });

  it('answers product_not_enabled for an org without superpipeline', async () => {
    await withOrgPlane(async () => {
      const res = await rpc(await planeToken({ org: OTHER_ORG, ent: [] }, { aud: MCP_AUD }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'product_not_enabled', org: OTHER_ORG });
    });
  });

  it('refuses a forged token and a service token', async () => {
    await withOrgPlane(async () => {
      const stranger = (await generateKeyPair('EdDSA')).privateKey;
      expect((await rpc(await planeToken({}, { aud: MCP_AUD, kid: 'x', key: stranger }))).status).toBe(401);
      expect((await rpc(await planeToken({ principalKind: 'service' }, { aud: MCP_AUD }))).status).toBe(401);
    });
  });

  it('still accepts a spa_ token in plane mode', async () => {
    await withOrgPlane(async () => {
      const agent = await createAgent(env.DB, 'tnt_mcp_spa', { name: 'Spa', capabilities: ['x'] });
      const { token } = await createAgentToken(env.DB, 'tnt_mcp_spa', agent.id, ['claim']);
      expect((await rpc(token)).status).toBe(200);
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @superpipeline/api exec vitest run test/mcp-org-plane.test.ts`
Expected: FAIL. The challenge names the root metadata, and plane tokens get 401.

- [ ] **Step 3: Add `resolvePlaneMcp`** (append to `apps/api/src/auth/org-plane-resolve.ts`)

```ts
import type { McpAuth } from '../mcp/tools';
import { effectiveCapabilities } from '../db/implications';

export async function resolvePlaneMcp(request: Request, env: Env, cfg: OrgPlaneConfig): Promise<McpAuth | null> {
  const claims = await planeClaimsFor(request, cfg, cfg.mcpAudience);
  if (!claims || !entitles(claims)) return null;
  if (claims.principalKind === 'agent') {
    const found = await findAgentByExternal(env.DB, ORG_PLANE_SOURCE, claims.sub);
    if (!found) return null;
    const tenantId = await findTenantByExternal(env.DB, ORG_PLANE_SOURCE, claims.org);
    if (!tenantId || tenantId !== found.tenantId) return null;
    return {
      tenantId,
      agentId: found.agentId,
      capabilities: await effectiveCapabilities(env.DB, tenantId, found.capabilities),
      scopes: null,
      externalId: claims.sub,
    };
  }
  if (claims.principalKind === 'human') {
    const tenantId = await ensureOrgTenant(env.DB, claims.org);
    const human = await provisionOrgHuman(env.DB, tenantId, claims);
    if (!human) return null;
    // `scopes: []` registers only the unscoped (read) tools — TOOL_SCOPE gates the rest.
    return { tenantId, agentId: human.userId, capabilities: [], scopes: [], externalId: claims.sub };
  }
  return null;
}
```

- [ ] **Step 4: Plane branch, metadata and challenge** (`apps/api/src/mcp/auth.ts`)

In `resolveMcpAuth`, after the `spa_` block and **before** the `DEV_AUTH` block:

```ts
  const plane = orgPlaneMode(env);
  if (plane.kind === 'on') return token ? resolvePlaneMcp(request, env, plane.cfg) : null;
  if (plane.kind === 'invalid') return null;
```

Replace `unauthorized` and `protectedResourceMetadata` with:

```ts
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
```

Rewrite the header comment of `mcp/auth.ts` so it states both modes. Keep the "no audience validation" paragraph for hub mode, and add that plane mode validates `aud = ${ORG_PLANE_AUDIENCE}/mcp`.

- [ ] **Step 5: Routing** (`apps/api/src/index.ts:469-478`)

```ts
    if (request.method === 'GET' && path.startsWith(MCP_PROTECTED_RESOURCE_PATH)) {
      const meta = protectedResourceMetadata(request, env, path);
      if (meta) return meta;
    }
    if (path === '/mcp') {
      const auth = await resolveMcpAuth(request, env);
      if (!auth) return unauthorized(request, env);
      return handleMcpRequest(request, env, auth);
    }
```

In `apps/api/wrangler.jsonc:114`, extend `run_worker_first`, so the SPA fallback can never answer discovery with `index.html`:

```jsonc
    "run_worker_first": ["/v1/*", "/auth/*", "/hub/*", "/mcp", "/health", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/*"]
```

- [ ] **Step 6: Run, revert-proof, run all**

Run: `pnpm --filter @superpipeline/api exec vitest run test/mcp-org-plane.test.ts test/oauth-surface.test.ts test/mcp-http.test.ts test/mcp-scopes.test.ts`
Expected: PASS. `oauth-surface.test.ts` stays green because it runs with plane mode off.

Revert-proof: change `cfg.mcpAudience` to `cfg.audience` in `resolvePlaneMcp`, then confirm the "app audience at /mcp" test goes red. Restore it.

Run: `pnpm --filter @superpipeline/api test && pnpm --filter @superpipeline/api typecheck`

- [ ] **Step 7: Docs**

In `docs/05-integration-surfaces.md`, under the `/mcp` section, add a paragraph headed **"After the Organization-plane cutover"**. It should say three things:
- With `ORG_PLANE_ISSUER` set, `/mcp` accepts plane tokens whose `aud` is `<app>/mcp`.
- `/.well-known/oauth-protected-resource/mcp` names the plane as the authorization server, so a spec-following MCP client completes discovery and consent at the plane.
- A human gets read tools only; an agent gets its scoped verbs.

Keep the existing "shell" description as the pre-cutover state.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/auth/org-plane-resolve.ts apps/api/src/mcp/auth.ts apps/api/src/index.ts apps/api/wrangler.jsonc apps/api/test/mcp-org-plane.test.ts docs/05-integration-surfaces.md
git commit -m "feat(api): MCP accepts plane tokens and serves RFC 9728 metadata pointing at the plane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

After deploy (plane mode still off), check that the extended `run_worker_first` did not change anything visible: `curl -s https://app.superpipeline.dev/.well-known/oauth-protected-resource` must still return JSON with `authorization_servers: ["https://app.superpipeline.dev"]`.

---

### Task 6: The hosted app signs in through the plane; GitHub login is off

**Files:**
- Create: `apps/api/src/auth/plane-signin.ts`
- Modify: `apps/api/src/auth/hub-oauth.ts:88-125` (export the PKCE helpers `b64url`, `random256`, `challengeFor`, `constantTimeEqual`, `readCookie`, and the constant `TOKEN_COOKIE`); `:590-613` (`/hub/token` adds `signIn: 'github'`)
- Modify: `apps/api/src/index.ts:452-468` (plane routes are tried before `/auth/*` and `/hub/*`)
- Test: `apps/api/test/plane-signin.test.ts`

**Interfaces:**
- Consumes:
  - from Task 1: `orgPlaneMode`, `verifyOrgPlaneToken`, `entitles`;
  - from Task 3: `ensureOrgTenant`, `provisionOrgHuman`;
  - from Task 4: `productNotEnabled`;
  - existing: `planeAudience` (`hub-jwt.ts:157`), `signSession`, `sessionSetCookie`, `sessionClearCookie`, `SESSION_TTL_MS` (`session.ts`).
- Produces:
  - `export const PLANE_CLIENT_ID = 'superpipeline-web'`
  - `export const PLANE_CALLBACK_PATH = '/auth/callback'`
  - `export async function handlePlaneSignInRoute(request: Request, env: Env, path: string, fetchImpl?: typeof fetch): Promise<Response | null>`. It returns null when plane mode is off, or for a path it does not own.
  - `/hub/token` JSON gains `signIn: 'github' | 'org-plane'` in both modes, which Task 7 reads.

**Decision: reuse, not replace, `hub-oauth.ts`.** Its PKCE helpers and cookie discipline are right and tested. Its exchange (`POST /api/auth/token/exchange`, JSON body, `{ token }` response) is the hub's own protocol, not OAuth. The plane speaks standard OAuth 2.1 at `/api/auth/oauth2/token` (form body, `{ access_token, refresh_token, expires_in }`), so the flow itself is new code. `hub-oauth.ts` keeps working, untouched, while the switch is off.

**Workspace switching.** An OAuth token's `org` is fixed at consent time, and a refresh keeps it. `/hub/token` therefore never changes the workspace. A person who switches workspace at the plane walks `/auth/login` again, and the new session's tenant is the new token's `org`. The callback always derives the tenant from the token it just received, never from an existing session. A test below pins this.

**Routes in plane mode:**

| Route | Behaviour |
|---|---|
| `GET /auth/login` | Sets a PKCE cookie and 302s to `{ORG_PLANE_URL}/api/auth/oauth2/authorize`. Parameters: `client_id=superpipeline-web`, `redirect_uri={APP_URL}/auth/callback`, `response_type=code`, `scope=openid profile email offline_access`, `code_challenge_method=S256`, `resource={ORG_PLANE_AUDIENCE}`. |
| `GET /auth/callback` | Checks state, then exchanges at `{ORG_PLANE_URL}/api/auth/oauth2/token` with `resource`. Verifies the access token for the app audience; it must be a human with no `act` and `ent ∋ superpipeline`. Then: tenant by `org`, user by `sub`, a session cookie, and the access token in `superpipeline_hub_token` (Path=/hub). The rotating refresh token goes in `superpipeline_plane_refresh` (Path=/hub, HttpOnly, Secure, SameSite=Strict, 30 days). |
| `GET /hub/token` | Returns the token cookie. If it has lapsed and a refresh cookie exists, refreshes with `grant_type=refresh_token` and `resource`, then rotates both cookies. Always sends `hubConfigured: true, signIn: 'org-plane'`. |
| `POST /hub/connect` | `{ url: '/auth/login' }`. The page's existing "connect" button walks the same flow. |
| `GET /hub/callback` | 404. The plane never redirects there. |
| `/auth/logout` | Clears the session, token and refresh cookies. |
| `invalid` mode | `/auth/login` and `/auth/callback` answer 503 `Sign-in is not configured on this server.`, never the GitHub flow. |

- [ ] **Step 1: Write the failing test** (`apps/api/test/plane-signin.test.ts`)

```ts
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { planeEnv, planeKeys, planeToken, withOrgPlane, PLANE, PLANE_JWKS, APP_AUD, MCP_AUD, ORG, OTHER_ORG, HUMAN } from './helpers/org-plane';
import { handlePlaneSignInRoute } from '../src/auth/plane-signin';
import { verifySession } from '../src/auth/session';
import { findTenantByExternal, findUserByExternal } from '../src/db/catalog';
import { __resetJwksCacheForTests } from '../src/auth/hub-jwt';

beforeAll(setupCatalog);
beforeEach(() => __resetJwksCacheForTests());

const SECRET = 'plane-signin-secret';
const envOn = (over: Record<string, unknown> = {}) => planeEnv({ APP_URL: APP_AUD, SESSION_SECRET: SECRET, ...over });

/** The plane's token endpoint and JWKS, recording every token request body. */
function plane(answer: () => Record<string, unknown> | null) {
  const tokenRequests: URLSearchParams[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === PLANE_JWKS) return new Response((await planeKeys()).jwksBody, { headers: { 'content-type': 'application/json' } });
    if (url === `${PLANE}/api/auth/oauth2/token`) {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      const body = answer();
      return body ? Response.json(body) : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    return new Response('unexpected', { status: 599 });
  }) as unknown as typeof fetch;
  return { impl, tokenRequests };
}

function cookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie()) {
    const [pair] = c.split(';');
    const [k, ...v] = pair!.trim().split('=');
    out.set(k!, v.join('='));
  }
  return out;
}

async function login(e = envOn()) {
  const res = (await handlePlaneSignInRoute(new Request('https://api.test/auth/login'), e, '/auth/login'))!;
  const location = new URL(res.headers.get('Location')!);
  return { res, location, pkce: cookies(res).get('superpipeline_plane_pkce')!, state: location.searchParams.get('state')! };
}

async function callback(fake: ReturnType<typeof plane>, e = envOn()) {
  const { pkce, state } = await login(e);
  const req = new Request(`https://api.test/auth/callback?code=c0de&state=${state}`, { headers: { Cookie: `superpipeline_plane_pkce=${pkce}` } });
  return (await handlePlaneSignInRoute(req, e, '/auth/callback', fake.impl))!;
}

describe('plane sign-in — off means GitHub, unchanged', () => {
  it('returns null for every path when ORG_PLANE_ISSUER is unset', async () => {
    for (const p of ['/auth/login', '/auth/callback', '/hub/token', '/hub/connect']) {
      expect(await handlePlaneSignInRoute(new Request(`https://api.test${p}`), { ...env, SESSION_SECRET: SECRET } as never, p)).toBeNull();
    }
  });
});

describe('plane sign-in — authorize', () => {
  it('redirects to the plane as superpipeline-web with PKCE S256 and the app resource', async () => {
    const { res, location, pkce } = await login();
    expect(res.status).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe(`${PLANE}/api/auth/oauth2/authorize`);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'superpipeline-web',
      redirect_uri: `${APP_AUD}/auth/callback`,
      code_challenge_method: 'S256',
      resource: APP_AUD,
      scope: 'openid profile email offline_access',
    });
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce).toBeTruthy();
  });

  it('never sends anyone to GitHub in plane mode — through the real router', async () => {
    await withOrgPlane(async () => {
      (env as unknown as Record<string, unknown>).SESSION_SECRET = SECRET;
      const res = await SELF.fetch('https://api.test/auth/login', { redirect: 'manual' });
      expect(res.headers.get('Location') ?? '').not.toContain('github.com');
      expect(res.headers.get('Location') ?? '').toContain(`${PLANE}/api/auth/oauth2/authorize`);
      delete (env as unknown as Record<string, unknown>).SESSION_SECRET;
    });
  });

  it('answers 503 — not GitHub — when the switch is set but the configuration is incomplete', async () => {
    const res = await handlePlaneSignInRoute(new Request('https://api.test/auth/login'), envOn({ ORG_PLANE_URL: undefined }), '/auth/login');
    expect(res?.status).toBe(503);
  });
});

describe('plane sign-in — callback', () => {
  it('refuses a callback it did not start, without spending the code', async () => {
    const fake = plane(() => ({ access_token: 'unused' }));
    const req = new Request('https://api.test/auth/callback?code=c&state=forged');
    const res = (await handlePlaneSignInRoute(req, envOn(), '/auth/callback', fake.impl))!;
    expect(res.status).toBe(400);
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it('exchanges with resource and the verifier, then signs the person into the org tenant', async () => {
    const access = await planeToken();
    const fake = plane(() => ({ access_token: access, refresh_token: 'r1', expires_in: 300, token_type: 'Bearer' }));
    const res = await callback(fake);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');
    const sent = fake.tokenRequests[0]!;
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('client_id')).toBe('superpipeline-web');
    expect(sent.get('resource')).toBe(APP_AUD);
    expect(sent.get('redirect_uri')).toBe(`${APP_AUD}/auth/callback`);
    expect(sent.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const c = cookies(res);
    const session = await verifySession(c.get('superpipeline_session')!, SECRET);
    expect(session?.tenantId).toBe(await findTenantByExternal(env.DB, 'org-plane', ORG));
    expect(session?.userId).toBe((await findUserByExternal(env.DB, 'org-plane', HUMAN))?.id);
    expect(c.get('superpipeline_hub_token')).toBe(access);
    expect(c.get('superpipeline_plane_refresh')).toBe('r1');
  });

  it('answers product_not_enabled when the workspace has not enabled superpipeline', async () => {
    const access = await planeToken({ org: OTHER_ORG, ent: ['agentpod'] });
    const res = await callback(plane(() => ({ access_token: access, expires_in: 300 })));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'product_not_enabled', org: OTHER_ORG });
  });

  it('a fresh sign-in whose token names another org lands in THAT org\'s tenant (workspace switch = re-authorize)', async () => {
    const original = await planeToken();
    const first = await callback(plane(() => ({ access_token: original, expires_in: 300 })));
    const firstSession = await verifySession(cookies(first).get('superpipeline_session')!, SECRET);
    expect(firstSession?.tenantId).toBe(await findTenantByExternal(env.DB, 'org-plane', ORG));
    const switched = await planeToken({ org: 'org_00000000000000000c03' });
    const res = await callback(plane(() => ({ access_token: switched, expires_in: 300 })));
    const session = await verifySession(cookies(res).get('superpipeline_session')!, SECRET);
    expect(session?.tenantId).toBe(await findTenantByExternal(env.DB, 'org-plane', 'org_00000000000000000c03'));
  });

  it.each([
    ['an MCP-audience token', async () => planeToken({}, { aud: MCP_AUD })],
    ['an agent token', async () => planeToken({ principalKind: 'agent' })],
    ['a delegated (act) token', async () => planeToken({ act: { sub: 'prn_000000000000000000ff' } })],
  ])('mints no session from %s', async (_name, mint) => {
    const access = await mint();
    const res = await callback(plane(() => ({ access_token: access, expires_in: 300 })));
    expect(cookies(res).has('superpipeline_session')).toBe(false);
    expect(res.headers.get('Location')).toBe('/?signin=no-account');
  });
});

describe('plane sign-in — the SPA keeps authority past five minutes', () => {
  it('refreshes through the rotating refresh token when the access token cookie has lapsed', async () => {
    const renewed = await planeToken({ mayDispatch: [] });
    const fake = plane(() => ({ access_token: renewed, refresh_token: 'r2', expires_in: 300 }));
    const req = new Request('https://api.test/hub/token', { headers: { Cookie: 'superpipeline_plane_refresh=r1' } });
    const res = (await handlePlaneSignInRoute(req, envOn(), '/hub/token', fake.impl))!;
    expect(await res.json()).toEqual({ token: renewed, hubConfigured: true, signIn: 'org-plane' });
    expect(fake.tokenRequests[0]!.get('grant_type')).toBe('refresh_token');
    expect(fake.tokenRequests[0]!.get('refresh_token')).toBe('r1');
    expect(fake.tokenRequests[0]!.get('resource')).toBe(APP_AUD);
    expect(cookies(res).get('superpipeline_plane_refresh')).toBe('r2');
  });

  it('answers token: null and drops the refresh cookie when the plane refuses the refresh', async () => {
    const fake = plane(() => null);
    const req = new Request('https://api.test/hub/token', { headers: { Cookie: 'superpipeline_plane_refresh=revoked' } });
    const res = (await handlePlaneSignInRoute(req, envOn(), '/hub/token', fake.impl))!;
    expect(await res.json()).toEqual({ token: null, hubConfigured: true, signIn: 'org-plane' });
    expect(cookies(res).get('superpipeline_plane_refresh')).toBe('');
  });

  it('serves a live token cookie without calling the plane', async () => {
    const fake = plane(() => null);
    const req = new Request('https://api.test/hub/token', { headers: { Cookie: 'superpipeline_hub_token=abc' } });
    const res = (await handlePlaneSignInRoute(req, envOn(), '/hub/token', fake.impl))!;
    expect((await res.json() as { token: string }).token).toBe('abc');
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it('points the connect button at the same sign-in, and retires /hub/callback', async () => {
    const connect = (await handlePlaneSignInRoute(new Request('https://api.test/hub/connect', { method: 'POST' }), envOn(), '/hub/connect'))!;
    expect(await connect.json()).toEqual({ url: '/auth/login' });
    const cb = (await handlePlaneSignInRoute(new Request('https://api.test/hub/callback'), envOn(), '/hub/callback'))!;
    expect(cb.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @superpipeline/api exec vitest run test/plane-signin.test.ts`
Expected: FAIL — module `../src/auth/plane-signin` not found.

- [ ] **Step 3: Export the helpers from `hub-oauth.ts`**

Add `export` to `b64url`, `random256`, `challengeFor`, `constantTimeEqual`, `readCookie`, and `const TOKEN_COOKIE`. In the `/hub/token` response (`:609-612`), add `signIn: 'github' as const`. That is additive: existing tests read only `token` and `hubConfigured`.

- [ ] **Step 4: Write `apps/api/src/auth/plane-signin.ts`**

```ts
/**
 * Signing in to the hosted app through the Organization plane (contract §3.1): an OAuth 2.1
 * public client, `superpipeline-web`, authorization code + PKCE S256, `resource` on every token
 * request. Inert unless ORG_PLANE_ISSUER is set; while it is set the GitHub flow in `routes.ts`
 * is unreachable, because this handler answers `/auth/login` and `/auth/callback` first.
 */
import type { Env } from '../env';
import { planeAudience } from './hub-jwt';
import { random256, challengeFor, constantTimeEqual, readCookie, TOKEN_COOKIE } from './hub-oauth';
import { entitles, orgPlaneMode, verifyOrgPlaneToken, type OrgPlaneConfig } from './org-plane';
import { ensureOrgTenant, provisionOrgHuman } from './org-tenancy';
import { productNotEnabled } from './org-plane-resolve';
import { signSession, sessionSetCookie, sessionClearCookie, SESSION_TTL_MS } from './session';

export const PLANE_CLIENT_ID = 'superpipeline-web';
export const PLANE_CALLBACK_PATH = '/auth/callback';
const PKCE_COOKIE = 'superpipeline_plane_pkce';
const REFRESH_COOKIE = 'superpipeline_plane_refresh';
const SCOPE = 'openid profile email offline_access';
const REFRESH_MAX_AGE_S = 30 * 24 * 3600;

const pkceCookie = (v: string, maxAge: number) => `${PKCE_COOKIE}=${v}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const tokenCookie = (v: string, maxAge: number) => `${TOKEN_COOKIE}=${v}; Path=/hub; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
const refreshCookie = (v: string, maxAge: number) => `${REFRESH_COOKIE}=${v}; Path=/hub; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number }

function text(status: number, body: string, headers: HeadersInit = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}

async function tokenRequest(cfg: OrgPlaneConfig, form: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse | null> {
  try {
    const res = await fetchImpl(`${cfg.url}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...form, client_id: PLANE_CLIENT_ID, resource: cfg.audience }).toString(),
      redirect: 'manual',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as TokenResponse;
    return typeof body.access_token === 'string' && body.access_token !== '' ? body : null;
  } catch {
    return null;
  }
}

const ttlOf = (t: TokenResponse) => Math.max(1, Math.min(typeof t.expires_in === 'number' ? t.expires_in : 300, 3600));

export async function handlePlaneSignInRoute(
  request: Request,
  env: Env,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | null> {
  const mode = orgPlaneMode(env);
  if (mode.kind === 'off') return null;
  const owned = ['/auth/login', PLANE_CALLBACK_PATH, '/auth/logout', '/hub/token', '/hub/connect', '/hub/callback'];
  if (!owned.includes(path)) return null;
  if (mode.kind === 'invalid' || !env.SESSION_SECRET) {
    return path.startsWith('/auth/') && path !== '/auth/logout'
      ? text(503, 'Sign-in is not configured on this server.')
      : Response.json({ error: 'sign-in is not configured' }, { status: 503 });
  }
  const { cfg } = mode;
  const redirectUri = new URL(PLANE_CALLBACK_PATH, planeAudience(request, env)).toString();

  if (path === '/auth/login') {
    const verifier = random256();
    const state = random256();
    const authorize = new URL(`${cfg.url}/api/auth/oauth2/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code', client_id: PLANE_CLIENT_ID, redirect_uri: redirectUri, scope: SCOPE, state,
      code_challenge: await challengeFor(verifier), code_challenge_method: 'S256', resource: cfg.audience,
    })) authorize.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { Location: authorize.toString(), 'Set-Cookie': pkceCookie(`${state}.${verifier}`, 600) } });
  }

  if (path === PLANE_CALLBACK_PATH) {
    const u = new URL(request.url);
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const [storedState, verifier] = (readCookie(request, PKCE_COOKIE) ?? '').split('.');
    const clear = { 'Set-Cookie': pkceCookie('', 0) };
    if (!code || !state || !storedState || !verifier || !constantTimeEqual(state, storedState)) {
      return text(400, 'This sign-in could not be verified. Please try again.', clear);
    }
    const tokens = await tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, fetchImpl);
    if (!tokens) return text(400, 'The sign-in service declined to issue a token. Please try again.', clear);

    const claims = await verifyOrgPlaneToken(tokens.access_token!, cfg, cfg.audience, fetchImpl);
    const headers = new Headers(clear);
    if (claims && !entitles(claims)) {
      const refused = productNotEnabled(claims.org);
      refused.headers.append('Set-Cookie', pkceCookie('', 0));
      return refused;
    }
    // Same refusals as `signInFromHubToken`: only a person who was present at an authorize flow.
    if (!claims || claims.principalKind !== 'human' || claims.act) {
      headers.set('Location', '/?signin=no-account');
      return new Response(null, { status: 302, headers });
    }
    const tenantId = await ensureOrgTenant(env.DB, claims.org);
    const human = await provisionOrgHuman(env.DB, tenantId, claims);
    if (!human) {
      headers.set('Location', '/?signin=no-account');
      return new Response(null, { status: 302, headers });
    }
    const name = claims.email ?? 'Member';
    const session = await signSession({ userId: human.userId, tenantId, name, exp: Date.now() + SESSION_TTL_MS }, env.SESSION_SECRET);
    headers.set('Location', '/');
    headers.append('Set-Cookie', sessionSetCookie(session, { secure: true }));
    headers.append('Set-Cookie', tokenCookie(tokens.access_token!, ttlOf(tokens)));
    if (tokens.refresh_token) headers.append('Set-Cookie', refreshCookie(tokens.refresh_token, REFRESH_MAX_AGE_S));
    return new Response(null, { status: 302, headers });
  }

  if (path === '/auth/logout') {
    const headers = new Headers({ Location: '/' });
    headers.append('Set-Cookie', sessionClearCookie({ secure: true }));
    headers.append('Set-Cookie', tokenCookie('', 0));
    headers.append('Set-Cookie', refreshCookie('', 0));
    return new Response(null, { status: request.method === 'POST' ? 204 : 302, headers });
  }

  if (path === '/hub/token') {
    const live = readCookie(request, TOKEN_COOKIE);
    if (live) return Response.json({ token: live, hubConfigured: true, signIn: 'org-plane' });
    const refresh = readCookie(request, REFRESH_COOKIE);
    if (!refresh) return Response.json({ token: null, hubConfigured: true, signIn: 'org-plane' });
    const tokens = await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refresh }, fetchImpl);
    const headers = new Headers();
    if (!tokens) {
      headers.append('Set-Cookie', refreshCookie('', 0));
      return Response.json({ token: null, hubConfigured: true, signIn: 'org-plane' }, { headers });
    }
    headers.append('Set-Cookie', tokenCookie(tokens.access_token!, ttlOf(tokens)));
    // Rotation: the old refresh token is spent; keep only the new one.
    headers.append('Set-Cookie', refreshCookie(tokens.refresh_token ?? '', tokens.refresh_token ? REFRESH_MAX_AGE_S : 0));
    return Response.json({ token: tokens.access_token, hubConfigured: true, signIn: 'org-plane' }, { headers });
  }

  if (path === '/hub/connect') {
    if (request.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 });
    return Response.json({ url: '/auth/login' });
  }

  // /hub/callback: the plane is never configured to redirect here.
  return Response.json({ error: 'not used when signing in through the organization plane' }, { status: 404 });
}
```

- [ ] **Step 5: Route it first** (`apps/api/src/index.ts`, immediately before the `/auth/` block at `:452`)

```ts
    // Organization-plane sign-in owns /auth/login, /auth/callback, /auth/logout and /hub/{token,
    // connect,callback} once ORG_PLANE_ISSUER is set; it answers null otherwise, and the GitHub and
    // hub-handoff routes below run exactly as before.
    if (path.startsWith('/auth/') || path.startsWith('/hub/')) {
      const res = await handlePlaneSignInRoute(request, env, path);
      if (res) return res;
    }
```

- [ ] **Step 6: Run, revert-proof, run all**

Run: `pnpm --filter @superpipeline/api exec vitest run test/plane-signin.test.ts test/hub-oauth.test.ts test/hub-signin.test.ts test/github-oauth.test.ts`
Expected: PASS. Revert-proof, one at a time:
- Remove `resource: cfg.audience` from `tokenRequest`: the exchange test should go red.
- Remove `|| claims.act`: the act case should go red.

Run: `pnpm --filter @superpipeline/api test && pnpm --filter @superpipeline/api typecheck`

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/plane-signin.ts apps/api/src/auth/hub-oauth.ts apps/api/src/index.ts apps/api/test/plane-signin.test.ts
git commit -m "feat(api): sign in through the Organization plane as superpipeline-web; GitHub off in plane mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The web app shows one sign-in and stops sending plane tokens to the hub

**Files:**
- Modify: `apps/web/src/lib/hub-token.ts:76-123, 152-170` (`HubStatus.signIn`; skip the hub fallback in plane mode; `signInMode()`)
- Modify: `apps/web/src/lib/api.ts:861-879` (`getHubPrincipals` returns null in plane mode)
- Modify: `apps/web/src/lib/sign-in.ts` (add `signInChoices`)
- Modify: `apps/web/src/lib/components/Landing.svelte:40-60, 111-128`
- Test: `apps/web/src/lib/hub-token.test.ts`, `apps/web/src/lib/sign-in.test.ts` (create it if it does not exist)

**Interfaces:**
- Consumes: the `/hub/token` body `{ token, hubConfigured, signIn }` from Task 6.
- Produces:
  - `HubStatus` gains `signIn: 'github' | 'org-plane'`. A missing value reads as `'github'`.
  - `export function signInMode(): 'github' | 'org-plane' | null`, the last mode `hubStatus()` saw (null before the first call).
  - `export function signInChoices(status: Pick<HubStatus, 'configured' | 'signIn'>): { primary: { href: string; label: string }; offerHubConnect: boolean }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/lib/hub-token.test.ts`:

```ts
describe('plane mode', () => {
  it('reports signIn from our back end, defaulting to github for an older Worker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: null, hubConfigured: true }), { status: 200 })));
    expect((await hubStatus()).signIn).toBe('github');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: null, hubConfigured: true, signIn: 'org-plane' }), { status: 200 })));
    expect((await hubStatus()).signIn).toBe('org-plane');
  });

  it('never falls back to the hub directly in plane mode — a plane token is not the hub\'s', async () => {
    const fetchSpy = vi.fn(async (url: string) =>
      String(url).startsWith('/hub/token')
        ? new Response(JSON.stringify({ token: null, hubConfigured: true, signIn: 'org-plane' }), { status: 200 })
        : new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await hubToken()).toBeNull();
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(['/hub/token']);
  });
});
```

Create or append `apps/web/src/lib/sign-in.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { signInChoices } from './sign-in';

describe('signInChoices', () => {
  it('offers GitHub, plus the hub connect, before cutover', () => {
    expect(signInChoices({ configured: true, signIn: 'github' })).toEqual({
      primary: { href: '/auth/login', label: 'Sign in with GitHub' },
      offerHubConnect: true,
    });
  });

  it('offers one sign-in and no separate hub button in plane mode', () => {
    expect(signInChoices({ configured: true, signIn: 'org-plane' })).toEqual({
      primary: { href: '/auth/login', label: 'Sign in' },
      offerHubConnect: false,
    });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @superpipeline/web exec vitest run src/lib/hub-token.test.ts src/lib/sign-in.test.ts`
Expected: FAIL. `signIn` is undefined, and `signInChoices` is not exported.

- [ ] **Step 3: Implement**

In `hub-token.ts`:

```ts
export interface HubStatus {
  configured: boolean;
  token: string | null;
  /** How this deployment signs people in. Absent (an older Worker) reads as GitHub. */
  signIn: 'github' | 'org-plane';
}

let lastSignIn: 'github' | 'org-plane' | null = null;
export function signInMode(): 'github' | 'org-plane' | null {
  return lastSignIn;
}

export async function hubStatus(): Promise<HubStatus> {
  try {
    const res = await fetch('/hub/token', { credentials: 'same-origin' });
    if (!res.ok) return { configured: false, token: null, signIn: 'github' };
    const body = (await res.json()) as { token?: string | null; hubConfigured?: boolean; signIn?: string };
    const signIn = body.signIn === 'org-plane' ? 'org-plane' : 'github';
    lastSignIn = signIn;
    return { configured: body.hubConfigured === true, token: remember(body.token), signIn };
  } catch {
    return { configured: false, token: null, signIn: 'github' };
  }
}
```

In `hubToken()`, replace `return (await hubStatus()).token ?? (await tokenFromHubDirectly());` with:

```ts
      const status = await hubStatus();
      // In plane mode the token is the app's (aud = this deployment); the hub would refuse it, and
      // there is no hub cookie to fall back on. Null is the ordinary answer.
      if (status.signIn === 'org-plane') return status.token;
      return status.token ?? (await tokenFromHubDirectly());
```

In `api.ts` `getHubPrincipals`, after obtaining `token`, add `if (signInMode() === 'org-plane') return null;` and import `signInMode`. The comment should say: "A plane token's audience is this deployment, not the hub. Restoring the picker needs a hub-audience token; see the P3 plan's open questions."

In `sign-in.ts`:

```ts
export function signInChoices(status: { configured: boolean; signIn: 'github' | 'org-plane' }) {
  return status.signIn === 'org-plane'
    ? { primary: { href: '/auth/login', label: 'Sign in' }, offerHubConnect: false }
    : { primary: { href: '/auth/login', label: 'Sign in with GitHub' }, offerHubConnect: status.configured };
}
```

In `Landing.svelte`, replace `let hubConfigured = $state(false);` with `let choices = $state(signInChoices({ configured: false, signIn: 'github' }));`. Set it in `onMount` from `hubStatus()`. Render `choices.primary.label`, and show the GitHub mark only when `choices.primary.label` mentions GitHub. Guard the AgentPod button with `{#if choices.offerHubConnect}`.

- [ ] **Step 4: Run tests, typecheck, and the browser suite**

Run: `pnpm --filter @superpipeline/web exec vitest run && pnpm --filter @superpipeline/web typecheck && pnpm --filter @superpipeline/web e2e`
Expected: PASS. The e2e suite runs with no plane, so the landing still shows "Sign in with GitHub".

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/hub-token.ts apps/web/src/lib/hub-token.test.ts apps/web/src/lib/sign-in.ts apps/web/src/lib/sign-in.test.ts apps/web/src/lib/api.ts apps/web/src/lib/components/Landing.svelte
git commit -m "feat(web): one sign-in in plane mode; never send a plane token to the hub

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The run reporter gets its token from the plane

**Files:**
- Modify: `apps/api/src/superwitness/config.ts:7-47`
- Modify: `apps/api/src/superwitness/client.ts:33-64` (`ServiceTokenCache.get`)
- Modify: `apps/api/src/env.ts:53-57` (doc comment on `SUPERWITNESS_REPORTER_CREDENTIAL`: hub `svc_` before cutover, plane `svc_` after)
- Test: `apps/api/test/superwitness-plane-token.test.ts`

**Interfaces:**
- Consumes: `orgPlaneMode` (Task 1).
- Produces: `ReporterConfig` gains `tokenAudience: string | null`. It is null in hub mode. In plane mode it is the audience that superwitness verifies: `SUPERWITNESS_URL` with any trailing slash removed. Signature: `reporterConfig(env: Pick<Env, 'SUPERWITNESS_URL' | 'HUB_ISSUER' | 'SUPERWITNESS_REPORTER_CREDENTIAL' | 'ORG_PLANE_ISSUER' | 'ORG_PLANE_JWKS_URL' | 'ORG_PLANE_AUDIENCE' | 'ORG_PLANE_URL'>): ReporterConfig | { error: string }`.

In plane mode the request is `POST {ORG_PLANE_URL}/api/token/service`, `Authorization: Bearer <svc_…:secret>`, body `{"audience":"<SUPERWITNESS_URL>"}`. The response is `{ access_token, token_type, expires_in }` (contract §3.3).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { reporterConfig } from '../src/superwitness/config';
import { ServiceTokenCache, type ReporterFetch } from '../src/superwitness/client';
import { PLANE_ENV, PLANE } from './helpers/org-plane';

const SW = 'https://witness.test';
const CRED = 'svc_00000000000000000001:secret';
const base = { SUPERWITNESS_URL: SW, HUB_ISSUER: 'https://hub.test', SUPERWITNESS_REPORTER_CREDENTIAL: CRED };

describe('reporter token source', () => {
  it('is the hub, unchanged, while plane mode is off', () => {
    expect(reporterConfig(base)).toEqual({ runsUrl: `${SW}/v1/runs`, tokenUrl: 'https://hub.test/api/auth/service-token', credential: CRED, tokenAudience: null });
  });

  it('is the plane service exchange, for superwitness\'s audience, in plane mode', () => {
    expect(reporterConfig({ ...base, ...PLANE_ENV })).toEqual({ runsUrl: `${SW}/v1/runs`, tokenUrl: `${PLANE}/api/token/service`, credential: CRED, tokenAudience: SW });
  });

  it('refuses to report when the switch is set but incomplete', () => {
    expect(reporterConfig({ ...base, ...PLANE_ENV, ORG_PLANE_URL: undefined })).toEqual({ error: 'org_plane_invalid' });
  });

  it('posts the audience and reads access_token / expires_in', async () => {
    const cfg = reporterConfig({ ...base, ...PLANE_ENV });
    if ('error' in cfg) throw new Error(cfg.error);
    const seen: RequestInit[] = [];
    const fetcher: ReporterFetch = async (_url, init) => {
      seen.push(init);
      return Response.json({ access_token: 'plane-tok', token_type: 'Bearer', expires_in: 300 });
    };
    const cache = new ServiceTokenCache();
    expect(await cache.get(cfg, fetcher, 0)).toEqual({ ok: true, token: 'plane-tok' });
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ audience: SW });
    expect(new Headers(seen[0]!.headers).get('Authorization')).toBe(`Bearer ${CRED}`);
    expect(await cache.get(cfg, fetcher, 1000)).toEqual({ ok: true, token: 'plane-tok' });
    expect(seen).toHaveLength(1);
  });

  it('treats a hub-shaped answer from the plane as a bad response', async () => {
    const cfg = reporterConfig({ ...base, ...PLANE_ENV });
    if ('error' in cfg) throw new Error(cfg.error);
    const r = await new ServiceTokenCache().get(cfg, async () => Response.json({ token: 't', expiresIn: 300 }), 0);
    expect(r).toEqual({ ok: false, status: 200, code: 'plane_bad_response' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @superpipeline/api exec vitest run test/superwitness-plane-token.test.ts`
Expected: FAIL. `tokenAudience` is missing, and the token URL still points at the hub.

- [ ] **Step 3: Implement**

In `config.ts`, add `tokenAudience: string | null` to `ReporterConfig`. Then, at the start of `reporterConfig` after the `sw` check:

```ts
  const plane = orgPlaneMode(env);
  if (plane.kind === 'invalid') return { error: 'org_plane_invalid' };
  const credential = env.SUPERWITNESS_REPORTER_CREDENTIAL?.trim() ?? '';
  const colon = credential.indexOf(':');
  if (colon <= 0 || colon === credential.length - 1) return { error: 'credential_missing' };
  if (plane.kind === 'on') {
    return {
      runsUrl: new URL('/v1/runs', sw).toString(),
      tokenUrl: `${plane.cfg.url}/api/token/service`,
      credential,
      tokenAudience: env.SUPERWITNESS_URL!.trim().replace(/\/+$/, ''),
    };
  }
  // …existing hub branch, returning tokenAudience: null…
```

In `client.ts` `ServiceTokenCache.get`:

```ts
    const plane = cfg.tokenAudience !== null;
    const prefix = plane ? 'plane' : 'hub';
    try {
      res = await fetcher(cfg.tokenUrl, {
        method: 'POST',
        headers: plane
          ? { Authorization: `Bearer ${cfg.credential}`, 'Content-Type': 'application/json' }
          : { Authorization: `Bearer ${cfg.credential}` },
        ...(plane ? { body: JSON.stringify({ audience: cfg.tokenAudience }) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(REPORTER_FETCH_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: 0, code: `${prefix}_unreachable` };
    }
    if (res.status !== 200) return { ok: false, status: res.status, code: `${prefix}_${res.status}` };
    const body = (await readJson(res)) as Record<string, unknown> | null;
    const token = plane ? body?.access_token : body?.token;
    const ttl = plane ? body?.expires_in : body?.expiresIn;
    if (typeof token !== 'string' || token === '' || typeof ttl !== 'number' || !(ttl > 0)) {
      return { ok: false, status: 200, code: `${prefix}_bad_response` };
    }
    this.token = token;
    this.refreshAtMs = nowMs + ttl * 1000 - TOKEN_REFRESH_MARGIN_MS;
    return { ok: true, token };
```

Every caller that builds a `ReporterConfig` literal in tests (`test/helpers/superwitness.ts`) gets `tokenAudience: null`. Find them with `grep -rn "tokenUrl:" apps/api/test`.

- [ ] **Step 4: Run all reporter tests and the suite**

Run: `pnpm --filter @superpipeline/api exec vitest run test/superwitness-plane-token.test.ts test/superwitness-client.test.ts test/superwitness-drain.test.ts test/superwitness-cron.test.ts && pnpm --filter @superpipeline/api test && pnpm --filter @superpipeline/api typecheck`
Expected: PASS. The `hub_*` error codes are unchanged in hub mode.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/superwitness/config.ts apps/api/src/superwitness/client.ts apps/api/src/env.ts apps/api/test/superwitness-plane-token.test.ts apps/api/test/helpers/superwitness.ts
git commit -m "feat(api): run reporter exchanges its service credential at the plane in plane mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `supi login` — device flow against the plane

**Files:**
- Create: `packages/cli/src/plane-login.ts`
- Modify: `packages/cli/src/credential.ts:57-65, 191-281` (`supiConfigDir`, plane device exchange, resolution order)
- Modify: `packages/cli/src/index.ts:34, 115-124, 150-160, 184, 203, 310-330` (verbs `login` and `logout`, help text, hints)
- Modify: `packages/cli/README.md` (the credential section)
- Test: `packages/cli/src/plane-login.test.ts`; append to `packages/cli/src/renewal.test.ts`

**Interfaces:**
- Consumes:
  - from Task 5: this server's `GET /.well-known/oauth-protected-resource`, which in plane mode returns `{ resource, authorization_servers: [issuer] }`;
  - from the contract (§3.2): `POST {plane}/api/auth/device/code`, `POST {plane}/api/auth/device/token`, and `POST {plane}/api/token/device`.
- Produces (`plane-login.ts`):
  - `export const SUPI_CLIENT_ID = 'supi'`
  - `export interface PlaneTarget { plane: string; audience: string }`
  - `export async function discoverPlane(base: string, fetchImpl?: typeof fetch): Promise<PlaneTarget | null>`
  - `export async function deviceLogin(target: PlaneTarget, io: { print(line: string): void; sleep(ms: number): Promise<void> }, fetchImpl?: typeof fetch): Promise<string>`, which returns the `device_credential`
  - `export async function exchangeDevice(target: PlaneTarget, credential: string, fetchImpl?: typeof fetch): Promise<{ token: string; expiresIn: number }>`
  - `export const DEVICE_CREDENTIAL = /^dev_[0-9a-f]{20}:[A-Za-z0-9_-]{43}$/`
- Produces (`credential.ts`):
  - `export function supiConfigDir(platform?: NodeJS.Platform): string`
  - `export function saveSupiDevice(d: { credential: string; plane: string; audience: string }): void`
  - `export function clearSupiCredentials(): void`

**Where the credential lives.** `<UserConfigDir>/superpipeline/device.json` (mode 0600) holds `{ credential, plane, audience }`. The token cache is `token.json` beside it. These mirror `fleetConfigDir`'s platform rules. Naming is listed as out of scope in design §11, so this is provisional; see open questions.

**Resolution order after this task:**
1. `$SUPERPIPELINE_AGENT_TOKEN_FILE`
2. `$SUPERPIPELINE_AGENT_TOKEN`
3. `$SUPERPIPELINE_TOKEN`
4. `$AGENTPOD_TOKEN`
5. **supi's own token cache, when fresh**
6. **supi's own device credential, exchanged at its recorded plane for its recorded audience**
7. `fleet login`'s token cache
8. `fleet login`'s device, renewed at the hub (unchanged; useful only while superpipeline is in hub mode)

Steps 5–6 outrank 7–8: `supi login` is the explicit act for this CLI.

- [ ] **Step 1: Write the failing test** (`packages/cli/src/plane-login.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPlane, deviceLogin, exchangeDevice, DEVICE_CREDENTIAL } from './plane-login';
import { resolveCredential, saveSupiDevice, supiConfigDir, fleetConfigDir } from './credential';

const PLANE = 'https://accounts.example';
const APP = 'https://work.example';
const CRED = `dev_${'a'.repeat(20)}:${'B'.repeat(43)}`;
const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ sub: 'prn_x', principalKind: 'human', exp })).toString('base64url')}.sig`;

let home: string;
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'supi-plane-'));
  for (const [k, v] of Object.entries({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'xdg'), APPDATA: join(home, 'AppData'), SUPERPIPELINE_TOKEN: '', AGENTPOD_TOKEN: '', SUPERPIPELINE_AGENT_TOKEN: '', SUPERPIPELINE_AGENT_TOKEN_FILE: '', SUPERPIPELINE_URL: APP })) vi.stubEnv(k, v);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('discoverPlane', () => {
  it('reads the plane and the audience from this server\'s RFC 9728 metadata', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ resource: APP, authorization_servers: [PLANE] }));
    expect(await discoverPlane(APP)).toEqual({ plane: PLANE, audience: APP });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${APP}/.well-known/oauth-protected-resource`);
  });

  it('answers null for a server still on its own shell (authorization server = itself)', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ resource: `${APP}/mcp`, authorization_servers: [APP] }));
    expect(await discoverPlane(APP)).toBeNull();
  });
});

describe('deviceLogin', () => {
  it('asks for a code as client supi, waits through pending and slow_down, and returns the device credential', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: `${PLANE}/device`, verification_uri_complete: `${PLANE}/device?user_code=ABCD-EFGH`, expires_in: 600, interval: 5 }))
      .mockResolvedValueOnce(Response.json({ error: 'authorization_pending' }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ error: 'slow_down' }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ device_credential: CRED }));
    const lines: string[] = [];
    const sleeps: number[] = [];
    const cred = await deviceLogin({ plane: PLANE, audience: APP }, { print: (l) => lines.push(l), sleep: async (ms) => { sleeps.push(ms); } });
    expect(cred).toBe(CRED);
    const [codeUrl, codeInit] = fetchMock.mock.calls[0]!;
    expect(String(codeUrl)).toBe(`${PLANE}/api/auth/device/code`);
    expect(JSON.parse(String(codeInit!.body))).toEqual({ client_id: 'supi', scope: 'openid' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'dc', client_id: 'supi' });
    expect(sleeps).toEqual([5000, 5000, 10000]);
    expect(lines.join('\n')).toContain('ABCD-EFGH');
  });

  it('stops on access_denied and expired_token with a sentence, not a stack', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ device_code: 'dc', user_code: 'U', verification_uri_complete: `${PLANE}/d`, expires_in: 600, interval: 1 }))
      .mockResolvedValueOnce(Response.json({ error: 'access_denied' }, { status: 400 }));
    await expect(deviceLogin({ plane: PLANE, audience: APP }, { print: () => {}, sleep: async () => {} })).rejects.toThrow(/declined/);
  });

  it('refuses a device credential of the wrong shape (an RFC 8628 access_token is not one)', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ device_code: 'dc', user_code: 'U', verification_uri_complete: `${PLANE}/d`, expires_in: 600, interval: 1 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'opaque', token_type: 'Bearer', expires_in: 604799 }));
    await expect(deviceLogin({ plane: PLANE, audience: APP }, { print: () => {}, sleep: async () => {} })).rejects.toThrow(/unexpected/);
    expect(DEVICE_CREDENTIAL.test(CRED)).toBe(true);
  });
});

describe('exchangeDevice and the resolution order', () => {
  it('exchanges at /api/token/device for the recorded audience', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: jwt(Math.floor(Date.now() / 1000) + 300), token_type: 'Bearer', expires_in: 300 }));
    const r = await exchangeDevice({ plane: PLANE, audience: APP }, CRED);
    expect(r.expiresIn).toBe(300);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${PLANE}/api/token/device`);
    expect(JSON.parse(String(init!.body))).toEqual({ audience: APP });
    expect(new Headers(init!.headers).get('Authorization')).toBe(`Bearer ${CRED}`);
    expect(init!.redirect).toBe('error');
  });

  it('stores the device credential privately', () => {
    saveSupiDevice({ credential: CRED, plane: PLANE, audience: APP });
    const path = join(supiConfigDir(), 'device.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ credential: CRED, plane: PLANE, audience: APP });
  });

  it('prefers supi\'s own plane credential over fleet login\'s files', async () => {
    mkdirSync(fleetConfigDir(), { recursive: true });
    writeFileSync(join(fleetConfigDir(), 'token.json'), JSON.stringify({ token: jwt(1) }));
    writeFileSync(join(fleetConfigDir(), 'device.json'), JSON.stringify({ id: 'dev_old', secret: 's', hub: 'https://hub.example' }));
    saveSupiDevice({ credential: CRED, plane: PLANE, audience: APP });
    const fresh = jwt(Math.floor(Date.now() / 1000) + 300);
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: fresh, token_type: 'Bearer', expires_in: 300 }));
    const c = await resolveCredential();
    expect(c).toEqual({ token: fresh, source: join(supiConfigDir(), 'device.json'), kind: 'human' });
    expect(fetchMock.mock.calls.map((x) => String(x[0]))).toEqual([`${PLANE}/api/token/device`]);
  });

  it('still lets an explicit environment token win over supi\'s own credential', async () => {
    saveSupiDevice({ credential: CRED, plane: PLANE, audience: APP });
    vi.stubEnv('SUPERPIPELINE_TOKEN', jwt(Math.floor(Date.now() / 1000) + 300));
    expect((await resolveCredential())?.source).toBe('env:SUPERPIPELINE_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the device secret only to the recorded plane, never to an http host', async () => {
    saveSupiDevice({ credential: CRED, plane: 'http://accounts.example', audience: APP });
    await expect(resolveCredential()).rejects.toThrow(/supi login/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @superpipeline/cli exec vitest run src/plane-login.test.ts`
Expected: FAIL — module `./plane-login` not found.

- [ ] **Step 3: Write `packages/cli/src/plane-login.ts`**

```ts
/**
 * `supi login`: the Organization plane's terminal sign-in (issuer contract §3.2). Not RFC 8628's
 * token response — the plane answers the device grant with a long-lived `device_credential`, and
 * every token after that comes from `/api/token/device`.
 */
export const SUPI_CLIENT_ID = 'supi';
export const DEVICE_CREDENTIAL = /^dev_[0-9a-f]{20}:[A-Za-z0-9_-]{43}$/;

export interface PlaneTarget { plane: string; audience: string }

function safeBase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) || u.username || u.password || u.search || u.hash) return null;
    return u.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export async function discoverPlane(base: string, fetchImpl: typeof fetch = fetch): Promise<PlaneTarget | null> {
  const res = await fetchImpl(`${base}/.well-known/oauth-protected-resource`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const meta = (await res.json()) as { resource?: unknown; authorization_servers?: unknown };
  const plane = safeBase(Array.isArray(meta.authorization_servers) ? meta.authorization_servers[0] : null);
  const audience = typeof meta.resource === 'string' ? meta.resource : null;
  if (!plane || !audience) return null;
  // A server still on its pre-cutover shell names itself; there is no plane to sign in at.
  if (new URL(plane).origin === new URL(base).origin) return null;
  return { plane, audience };
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown, auth?: string): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
}

export async function deviceLogin(
  target: PlaneTarget,
  io: { print(line: string): void; sleep(ms: number): Promise<void> },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const codeRes = await postJson(fetchImpl, `${target.plane}/api/auth/device/code`, { client_id: SUPI_CLIENT_ID, scope: 'openid' });
  if (!codeRes.ok) throw new Error(`The sign-in service would not start a device sign-in (HTTP ${codeRes.status}).`);
  const code = (await codeRes.json()) as { device_code?: string; user_code?: string; verification_uri_complete?: string; verification_uri?: string; expires_in?: number; interval?: number };
  if (!code.device_code || !code.user_code) throw new Error('The sign-in service returned an unexpected response.');
  io.print(`Open ${code.verification_uri_complete ?? code.verification_uri} and confirm the code ${code.user_code}.`);

  let interval = Math.max(1, code.interval ?? 5) * 1000;
  const deadline = Date.now() + Math.max(60, code.expires_in ?? 600) * 1000;
  while (Date.now() < deadline) {
    await io.sleep(interval);
    const res = await postJson(fetchImpl, `${target.plane}/api/auth/device/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code.device_code,
      client_id: SUPI_CLIENT_ID,
    });
    const body = (await res.json().catch(() => ({}))) as { device_credential?: unknown; error?: string };
    if (res.ok) {
      if (typeof body.device_credential === 'string' && DEVICE_CREDENTIAL.test(body.device_credential)) return body.device_credential;
      throw new Error('The sign-in service returned an unexpected response.');
    }
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') { interval += 5000; continue; }
    if (body.error === 'access_denied') throw new Error('The sign-in was declined.');
    if (body.error === 'expired_token') break;
    throw new Error(`The sign-in failed (${body.error ?? `HTTP ${res.status}`}).`);
  }
  throw new Error('The code expired before it was confirmed. Run supi login again.');
}

export async function exchangeDevice(target: PlaneTarget, credential: string, fetchImpl: typeof fetch = fetch): Promise<{ token: string; expiresIn: number }> {
  let res: Response;
  try {
    res = await postJson(fetchImpl, `${target.plane}/api/token/device`, { audience: target.audience }, credential);
  } catch {
    throw new Error('Could not reach the sign-in service. Check the connection and try again.');
  }
  if (res.status === 401 || res.status === 403 || res.status === 423) {
    throw new Error('The sign-in service refused this device (revoked, expired or suspended). Run supi login again.');
  }
  if (!res.ok) throw new Error(`Could not get a token (HTTP ${res.status}). Try again later.`);
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (typeof body?.access_token !== 'string' || typeof body.expires_in !== 'number') {
    throw new Error('The sign-in service returned an unusable token.');
  }
  return { token: body.access_token, expiresIn: body.expires_in };
}
```

- [ ] **Step 4: Extend `credential.ts`**

Add:

```ts
import { exchangeDevice, DEVICE_CREDENTIAL } from './plane-login';
import { chmodSync, mkdirSync } from 'node:fs';

/** supi's own directory — the same platform rules as fleetConfigDir, under "superpipeline". */
export function supiConfigDir(platform: NodeJS.Platform = process.platform): string {
  return join(fleetConfigDir(platform), '..', 'superpipeline');
}

function writePrivate(path: string, value: unknown): void {
  mkdirSync(supiConfigDir(), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(supiConfigDir(), '.supi-'));
  try {
    const tmp = join(staging, 'f.json');
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function saveSupiDevice(d: { credential: string; plane: string; audience: string }): void {
  writePrivate(join(supiConfigDir(), 'device.json'), d);
  rmSync(join(supiConfigDir(), 'token.json'), { force: true });
}

export function clearSupiCredentials(): void {
  rmSync(join(supiConfigDir(), 'device.json'), { force: true });
  rmSync(join(supiConfigDir(), 'token.json'), { force: true });
}

/** Steps 5–6 of the order: supi's cached plane token, else its device credential exchanged. Null when supi has none. */
async function supiPlaneCredential(): Promise<Credential | null> {
  const devicePath = join(supiConfigDir(), 'device.json');
  let device: { credential?: unknown; plane?: unknown; audience?: unknown };
  try {
    device = JSON.parse(readFileSync(devicePath, 'utf8'));
  } catch {
    return null;
  }
  try {
    const cached = JSON.parse(readFileSync(join(supiConfigDir(), 'token.json'), 'utf8')) as { token?: string };
    const c = typeof cached.token === 'string' ? inspect(cached.token) : null;
    if (c?.expiry && !expired(c)) return { token: cached.token!, source: join(supiConfigDir(), 'token.json'), kind: 'human' };
  } catch { /* no cache */ }
  const plane = typeof device.plane === 'string' ? device.plane : '';
  let ok = false;
  try {
    const u = new URL(plane);
    ok = u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch { ok = false; }
  if (!ok || typeof device.credential !== 'string' || !DEVICE_CREDENTIAL.test(device.credential) || typeof device.audience !== 'string') {
    throw new Error('The stored sign-in is not usable. Run supi login again.');
  }
  const { token } = await exchangeDevice({ plane: plane.replace(/\/+$/, ''), audience: device.audience }, device.credential);
  try { writePrivate(join(supiConfigDir(), 'token.json'), { token }); } catch { /* best effort */ }
  return { token, source: devicePath, kind: 'human' };
}
```

In `resolveCredential()`, right after `if (cached?.source.startsWith("env:")) return cached;`, insert:

```ts
  const own = await supiPlaneCredential();
  if (own) return own;
```

Update the module's top comment so the resolution order matches the eight-step list above.

- [ ] **Step 5: Verbs, help and hints** (`packages/cli/src/index.ts`)

Add before `case "whoami":`:

```ts
    case "login": {
      const target = await discoverPlane(baseUrl());
      if (!target) fail(`${baseUrl()} does not sign in through an organization plane yet.`, "  fleet login          the sign-in it uses today");
      const credential = await deviceLogin(target, {
        print: (l) => process.stdout.write(l + "\n"),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      }).catch((e) => fail(e instanceof Error ? e.message : String(e)));
      saveSupiDevice({ credential, plane: target.plane, audience: target.audience });
      await exchangeDevice(target, credential).catch((e) => fail(e instanceof Error ? e.message : String(e)));
      process.stdout.write("Signed in.\n");
      return;
    }
    case "logout":
      clearSupiCredentials();
      process.stdout.write("Signed out on this machine.\n");
      return;
```

Then update the text:
- The help block (`:115-124`): the credential line lists the eight-step order and names `supi login`.
- The "Not signed in." hint (`:154`): first line becomes `supi login           sign in to this workspace`, with `fleet login` kept below it.
- The 401 hint (`:203`) and the expired hint (`:184`): `"supi login"`.
- Add `supi login` and `supi logout` to the usage list near `:34`.

- [ ] **Step 6: Run the cli suite and typecheck**

Run: `pnpm --filter @superpipeline/cli test && pnpm --filter @superpipeline/cli typecheck`
Expected: PASS. Every existing `renewal.test.ts` case still passes, because no `superpipeline/device.json` exists in those homes.

Revert-proof: remove the `ok` scheme check, then confirm "never to an http host" goes red. Restore it.

- [ ] **Step 7: README and commit**

In `packages/cli/README.md`, replace the credential section with the eight-step order and one paragraph. The paragraph should say that after the plane cutover `supi login` is how a person signs in. It should also say that `AGENTPOD_TOKEN` will hold a token for the hub's audience, which superpipeline refuses, so do not export it into a shell that runs `supi`.

```bash
git add packages/cli/src/plane-login.ts packages/cli/src/plane-login.test.ts packages/cli/src/credential.ts packages/cli/src/index.ts packages/cli/README.md
git commit -m "feat(cli): supi login signs in through the Organization plane's device flow

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Re-pointing existing data at cutover (script, dry run first) and the runbook

**Files:**
- Create: `apps/api/src/db/repoint-org-plane.ts` (pure planner, no I/O)
- Create: `scripts/repoint-org-plane.ts` (Bun runner; snapshot → plan → optional apply → verify)
- Modify: `docs/12-deploy.md` (new section "Switching to the Organization plane")
- Test: `apps/api/test/repoint-org-plane.test.ts`

**Interfaces:**
- Consumes: the catalog schema (tenants and users external pairs; migration 0017's index).
- Produces:
  - `export interface RepointMapping { tenants: Record<string, string>; chosenTenants?: Record<string, string>; users: Record<string, string> }`. Keys: `tenants` maps `fleet_…` to `org_…`; `chosenTenants` maps `org_…` to `tnt_…`; `users` maps the hub user id to `prn_…`.
  - `export interface CatalogSnapshot { tenants: Array<{ id: string; external_source: string | null; external_id: string | null }>; users: Array<{ id: string; external_source: string | null; external_id: string | null }> }`
  - `export interface RepointPlan { statements: string[]; tenants: Array<{ id: string; from: string; to: string }>; users: Array<{ id: string; from: string; to: string }>; unmapped: { tenants: string[]; users: string[] }; conflicts: string[] }`
  - `export function planRepoint(snapshot: CatalogSnapshot, mapping: RepointMapping, direction: 'forward' | 'reverse'): RepointPlan`

**What gets re-pointed, and why only these.**

| Rows | Before | After (`forward`) | Why |
|---|---|---|---|
| `tenants` | `('agentpod', fleet_…)` | `('org-plane', org_…)` | `resolvePlaneUser` finds tenants by `org`. Without this, first sight would create a **new, empty** tenant beside the team's boards. |
| `users` | `('agentpod', <hub Better Auth user id>)` | `('org-plane', prn_…)` | Design §4/§8: the plane's human `user.id` **is** the `prn_`, and P4 preserves the hub's principal ids. The hub's Better Auth user id never appears in a plane token. |
| `agents` | `('org-plane', prn_…)` | unchanged | Already keyed by principal (`index.ts:1561`, `resolve.ts:306`). |
| Board Durable Object data | local `usr_…` ids, or a raw hub `sub` for a never-linked caller | unchanged | Local ids are stable. Raw hub subs already resolve through `hubSubjectsFor` for evidence and are not identities anyone signs in as again. |

**Mapping input.** P4 produces the mapping file from the hub export (design §8 step 2): `tenants` from the hub's fleet → organization mapping, and `users` from `SELECT user_id, id FROM principals WHERE kind = 'human'`. It is a deployment's data. It is never committed here, for the same reason `scripts/apply-stage-config.ts` keeps its configs out.

**Conflicts are refusals, not guesses.** Migration 0002 lets several personal tenants link one fleet. After re-pointing only one may hold the `org` (migration 0017). A fleet with more than one tenant and no `chosenTenants[org]` is reported as a conflict. So is a target `org` or `prn_` that another row already holds. `--write` refuses while any conflict remains. Unchosen tenants keep their `agentpod` mapping. Their data stays, unreachable through plane tokens until an operator decides (see open questions).

- [ ] **Step 1: Write the failing test** (`apps/api/test/repoint-org-plane.test.ts`)

```ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { planRepoint, type CatalogSnapshot, type RepointMapping } from '../src/db/repoint-org-plane';

beforeAll(setupCatalog);

const FLEET_A = 'fleet_000000000000000000aa';
const FLEET_B = 'fleet_000000000000000000bb';
const ORG_A = 'org_000000000000000000aa';
const ORG_B = 'org_000000000000000000bb';
const PRN_1 = 'prn_00000000000000000001';
const PRN_2 = 'prn_00000000000000000002';

async function seed() {
  await env.DB.exec(`DELETE FROM memberships; DELETE FROM users; DELETE FROM tenants;`);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO tenants (id, slug, name, external_source, external_id) VALUES ('tnt_a', 'a', 'A', 'agentpod', ?)`).bind(FLEET_A),
    env.DB.prepare(`INSERT INTO tenants (id, slug, name, external_source, external_id) VALUES ('tnt_b1', 'b1', 'B1', 'agentpod', ?)`).bind(FLEET_B),
    env.DB.prepare(`INSERT INTO tenants (id, slug, name, external_source, external_id) VALUES ('tnt_b2', 'b2', 'B2', 'agentpod', ?)`).bind(FLEET_B),
    env.DB.prepare(`INSERT INTO tenants (id, slug, name) VALUES ('tnt_solo', 'solo', 'Solo')`),
    env.DB.prepare(`INSERT INTO users (id, email, external_source, external_id) VALUES ('usr_1', 'one@example.com', 'agentpod', 'BetterAuthOne')`),
    env.DB.prepare(`INSERT INTO users (id, email, external_source, external_id) VALUES ('usr_2', 'two@example.com', 'agentpod', 'BetterAuthTwo')`),
    env.DB.prepare(`INSERT INTO users (id, email) VALUES ('usr_gh', 'gh@example.com')`),
  ]);
}

async function snapshot(): Promise<CatalogSnapshot> {
  const t = await env.DB.prepare(`SELECT id, external_source, external_id FROM tenants ORDER BY id`).all();
  const u = await env.DB.prepare(`SELECT id, external_source, external_id FROM users ORDER BY id`).all();
  return { tenants: t.results as CatalogSnapshot['tenants'], users: u.results as CatalogSnapshot['users'] };
}

async function apply(statements: string[]) {
  for (const s of statements) await env.DB.prepare(s).run();
}

const MAPPING: RepointMapping = {
  tenants: { [FLEET_A]: ORG_A, [FLEET_B]: ORG_B },
  chosenTenants: { [ORG_B]: 'tnt_b2' },
  users: { BetterAuthOne: PRN_1, BetterAuthTwo: PRN_2 },
};

beforeEach(seed);

describe('planRepoint', () => {
  it('re-points mapped tenants and users, and touches nothing else', async () => {
    const plan = planRepoint(await snapshot(), MAPPING, 'forward');
    expect(plan.conflicts).toEqual([]);
    expect(plan.tenants).toEqual([
      { id: 'tnt_a', from: `agentpod:${FLEET_A}`, to: `org-plane:${ORG_A}` },
      { id: 'tnt_b2', from: `agentpod:${FLEET_B}`, to: `org-plane:${ORG_B}` },
    ]);
    expect(plan.unmapped.tenants).toEqual(['tnt_b1']);
    await apply(plan.statements);
    const after = await snapshot();
    expect(after.tenants.find((t) => t.id === 'tnt_b1')).toMatchObject({ external_source: 'agentpod', external_id: FLEET_B });
    expect(after.tenants.find((t) => t.id === 'tnt_solo')).toMatchObject({ external_source: null });
    expect(after.users.find((u) => u.id === 'usr_1')).toMatchObject({ external_source: 'org-plane', external_id: PRN_1 });
    expect(after.users.find((u) => u.id === 'usr_gh')).toMatchObject({ external_source: null });
  });

  it('is idempotent: a second plan after applying is empty', async () => {
    await apply(planRepoint(await snapshot(), MAPPING, 'forward').statements);
    expect(planRepoint(await snapshot(), MAPPING, 'forward').statements).toEqual([]);
  });

  it('round-trips: reverse restores the hub mappings exactly', async () => {
    const before = await snapshot();
    await apply(planRepoint(before, MAPPING, 'forward').statements);
    await apply(planRepoint(await snapshot(), MAPPING, 'reverse').statements);
    expect(await snapshot()).toEqual(before);
  });

  it('reports a shared fleet with no chosen tenant as a conflict and writes nothing for it', async () => {
    const plan = planRepoint(await snapshot(), { ...MAPPING, chosenTenants: {} }, 'forward');
    expect(plan.conflicts).toEqual([`${FLEET_B} is linked by 2 tenants (tnt_b1, tnt_b2); name one in chosenTenants["${ORG_B}"]`]);
    expect(plan.statements.join('\n')).not.toContain(ORG_B);
  });

  it('reports a target already held by another row as a conflict', async () => {
    await env.DB.prepare(`INSERT INTO users (id, email, external_source, external_id) VALUES ('usr_new', 'new@example.com', 'org-plane', ?)`).bind(PRN_1).run();
    const plan = planRepoint(await snapshot(), MAPPING, 'forward');
    expect(plan.conflicts).toContain(`${PRN_1} is already held by usr_new`);
  });

  it('refuses malformed mapping ids instead of writing them', () => {
    expect(() => planRepoint({ tenants: [], users: [] }, { tenants: { [FLEET_A]: 'org_SHOUTING' }, users: {} }, 'forward')).toThrow(/org_/);
    expect(() => planRepoint({ tenants: [], users: [] }, { tenants: {}, users: { x: 'usr_not_a_principal' } }, 'forward')).toThrow(/prn_/);
  });

  it('guards every UPDATE on the old value, so a row changed since the snapshot is left alone', () => {
    const plan = planRepoint({ tenants: [{ id: 'tnt_a', external_source: 'agentpod', external_id: FLEET_A }], users: [] }, MAPPING, 'forward');
    expect(plan.statements[0]).toBe(
      `UPDATE tenants SET external_source = 'org-plane', external_id = '${ORG_A}', updated_at = datetime('now') WHERE id = 'tnt_a' AND external_source = 'agentpod' AND external_id = '${FLEET_A}';`,
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @superpipeline/api exec vitest run test/repoint-org-plane.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `apps/api/src/db/repoint-org-plane.ts`**

```ts
/**
 * The P4 cutover's data step for this catalog: move tenant and user external mappings from the hub's
 * ids to the Organization plane's. Pure — the runner (`scripts/repoint-org-plane.ts`) snapshots,
 * prints, applies and re-verifies. Every UPDATE is guarded on the value it replaces.
 */
export interface RepointMapping {
  tenants: Record<string, string>;
  chosenTenants?: Record<string, string>;
  users: Record<string, string>;
}
type Row = { id: string; external_source: string | null; external_id: string | null };
export interface CatalogSnapshot { tenants: Row[]; users: Row[] }
type Move = { id: string; from: string; to: string };
export interface RepointPlan {
  statements: string[];
  tenants: Move[];
  users: Move[];
  unmapped: { tenants: string[]; users: string[] };
  conflicts: string[];
}

const FLEET = /^fleet_[0-9a-f]{20}$/;
const ORG = /^org_[0-9a-f]{20}$/;
const PRN = /^prn_[0-9a-f]{20}$/;
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

function check(mapping: RepointMapping): void {
  for (const [fleet, org] of Object.entries(mapping.tenants)) {
    if (!FLEET.test(fleet)) throw new Error(`mapping.tenants key ${fleet} is not a fleet_ id`);
    if (!ORG.test(org)) throw new Error(`mapping.tenants[${fleet}] = ${org} is not an org_ id`);
  }
  for (const [hubId, prn] of Object.entries(mapping.users)) {
    if (!PRN.test(prn)) throw new Error(`mapping.users[${hubId}] = ${prn} is not a prn_ id`);
  }
}

function update(table: 'tenants' | 'users', id: string, from: [string, string], to: [string, string]): string {
  return `UPDATE ${table} SET external_source = ${q(to[0])}, external_id = ${q(to[1])}, updated_at = datetime('now') WHERE id = ${q(id)} AND external_source = ${q(from[0])} AND external_id = ${q(from[1])};`;
}

export function planRepoint(snapshot: CatalogSnapshot, mapping: RepointMapping, direction: 'forward' | 'reverse'): RepointPlan {
  check(mapping);
  const [fromSrc, toSrc] = direction === 'forward' ? ['agentpod', 'org-plane'] : ['org-plane', 'agentpod'];
  const tenantMap = direction === 'forward' ? mapping.tenants : Object.fromEntries(Object.entries(mapping.tenants).map(([f, o]) => [o, f]));
  const userMap = direction === 'forward' ? mapping.users : Object.fromEntries(Object.entries(mapping.users).map(([h, p]) => [p, h]));
  const plan: RepointPlan = { statements: [], tenants: [], users: [], unmapped: { tenants: [], users: [] }, conflicts: [] };

  // Tenants: group the candidates by the external id they will move from.
  const held = new Map(snapshot.tenants.filter((t) => t.external_source === toSrc).map((t) => [t.external_id!, t.id]));
  const byFrom = new Map<string, Row[]>();
  for (const t of snapshot.tenants) {
    if (t.external_source !== fromSrc || !t.external_id) continue;
    if (!(t.external_id in tenantMap)) { plan.unmapped.tenants.push(t.id); continue; }
    byFrom.set(t.external_id, [...(byFrom.get(t.external_id) ?? []), t]);
  }
  for (const [from, rows] of byFrom) {
    const to = tenantMap[from]!;
    let chosen = rows[0]!;
    if (rows.length > 1) {
      const org = direction === 'forward' ? to : from;
      const pick = mapping.chosenTenants?.[org];
      const found = rows.find((r) => r.id === pick);
      if (!found) {
        plan.conflicts.push(`${from} is linked by ${rows.length} tenants (${rows.map((r) => r.id).join(', ')}); name one in chosenTenants["${org}"]`);
        continue;
      }
      chosen = found;
      for (const r of rows) if (r !== found) plan.unmapped.tenants.push(r.id);
    }
    // Only an org-plane target is unique (migration 0017); agentpod targets may be shared.
    const holder = held.get(to);
    if (toSrc === 'org-plane' && holder && holder !== chosen.id) { plan.conflicts.push(`${to} is already held by ${holder}`); continue; }
    plan.statements.push(update('tenants', chosen.id, [fromSrc, from], [toSrc, to]));
    plan.tenants.push({ id: chosen.id, from: `${fromSrc}:${from}`, to: `${toSrc}:${to}` });
  }

  const heldUsers = new Map(snapshot.users.filter((u) => u.external_source === toSrc).map((u) => [u.external_id!, u.id]));
  for (const u of snapshot.users) {
    if (u.external_source !== fromSrc || !u.external_id) continue;
    const to = userMap[u.external_id];
    if (!to) { plan.unmapped.users.push(u.id); continue; }
    const holder = heldUsers.get(to);
    if (holder && holder !== u.id) { plan.conflicts.push(`${to} is already held by ${holder}`); continue; }
    plan.statements.push(update('users', u.id, [fromSrc, u.external_id], [toSrc, to]));
    plan.users.push({ id: u.id, from: `${fromSrc}:${u.external_id}`, to: `${toSrc}:${to}` });
  }
  plan.tenants.sort((a, b) => a.id.localeCompare(b.id));
  plan.unmapped.tenants.sort();
  return plan;
}
```

Run the test. If the reverse round-trip fails only on `updated_at`, change the test's `snapshot()` to select only `id, external_source, external_id` (it already does). The round-trip compares only those three columns.

- [ ] **Step 4: Write the runner** (`scripts/repoint-org-plane.ts`)

```ts
/**
 * Re-point this catalog's tenant and user mappings from the hub's ids to the Organization plane's
 * (P4 cutover; plan docs/superpowers/plans/2026-10-06-p3-org-plane-consumer.md Task 10).
 *
 * Dry run by default. The mapping file is a deployment's data and never lives in this repository.
 *
 *   bun scripts/repoint-org-plane.ts --mapping map.json                 # show the plan (remote D1)
 *   bun scripts/repoint-org-plane.ts --mapping map.json --write         # apply, then verify
 *   bun scripts/repoint-org-plane.ts --mapping map.json --reverse --write   # rollback
 *   add --local to run against the local dev D1
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planRepoint, type CatalogSnapshot, type RepointMapping } from '../apps/api/src/db/repoint-org-plane';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const mappingPath = args[args.indexOf('--mapping') + 1];
if (!flag('--mapping') || !mappingPath) throw new Error('usage: --mapping <file> [--reverse] [--write] [--local]');
const where = flag('--local') ? '--local' : '--remote';
const direction = flag('--reverse') ? 'reverse' : 'forward';

function d1(extra: string[]): string {
  return execFileSync('pnpm', ['--filter', '@superpipeline/api', 'exec', 'wrangler', 'd1', 'execute', 'superpipeline-catalog', where, ...extra], { encoding: 'utf8' });
}
function rows(sql: string): CatalogSnapshot['tenants'] {
  const out = JSON.parse(d1(['--json', '--command', sql])) as Array<{ results: CatalogSnapshot['tenants'] }>;
  return out[0]!.results;
}
function snapshot(): CatalogSnapshot {
  return {
    tenants: rows(`SELECT id, external_source, external_id FROM tenants ORDER BY id`),
    users: rows(`SELECT id, external_source, external_id FROM users ORDER BY id`),
  };
}

const mapping = JSON.parse(readFileSync(mappingPath, 'utf8')) as RepointMapping;
const plan = planRepoint(snapshot(), mapping, direction);
console.log(JSON.stringify({ direction, target: where, tenants: plan.tenants, users: plan.users, unmapped: plan.unmapped, conflicts: plan.conflicts, statements: plan.statements.length }, null, 2));

if (!flag('--write')) {
  console.log('\nDry run. Nothing was written. Re-run with --write to apply.');
  process.exit(plan.conflicts.length > 0 ? 2 : 0);
}
if (plan.conflicts.length > 0) {
  console.error('Refusing to write while conflicts remain. Resolve them in the mapping file (chosenTenants) first.');
  process.exit(2);
}
if (plan.statements.length > 0) {
  const file = join(mkdtempSync(join(tmpdir(), 'repoint-')), 'repoint.sql');
  writeFileSync(file, plan.statements.join('\n') + '\n');
  d1(['--file', file, '--yes']);
}
// Verify the outcome, not the trigger: a fresh snapshot must plan nothing.
const residue = planRepoint(snapshot(), mapping, direction);
if (residue.statements.length > 0) {
  console.error(`Applied, but ${residue.statements.length} statement(s) still pending — inspect before switching ORG_PLANE_*.`);
  process.exit(1);
}
console.log(`Applied ${plan.statements.length} statement(s); a fresh snapshot plans nothing.`);
```

Check the runner by hand against the local D1. These commands are run, not unit-tested, and the output is pasted into the PR:
- `pnpm --filter @superpipeline/api dev:setup`
- seed two `agentpod` tenants with `wrangler d1 execute superpipeline-catalog --local --command "…"`
- `bun scripts/repoint-org-plane.ts --mapping /tmp/map.json --local`, which should print the plan with exit 0
- the same command with `--write`, which should apply and verify
- the same command with `--reverse --write`, which should restore the mappings

- [ ] **Step 5: Runbook** (`docs/12-deploy.md`, new section)

Add "Switching to the Organization plane (P4)" containing exactly this sequence:

1. **Preconditions.**
   - The plane serves resources `https://app.superpipeline.dev` and `https://app.superpipeline.dev/mcp`.
   - Client `superpipeline-web` is registered with redirect `https://app.superpipeline.dev/auth/callback`.
   - Client `supi` exists for the device flow.
   - A service principal for the run reporter exists in the operator's org. It needs a `svc_` credential, and the plane must allow it to mint for superwitness's audience.
   - `ent` for the org includes `superpipeline`.
2. **Mapping file** from the hub export (fleet → org; hub user id → `prn_`). Run `bun scripts/repoint-org-plane.ts --mapping map.json` and resolve every conflict, or accept every `unmapped` row in writing on the P4 card.
3. **Freeze** (design §8 step 1). Then, back to back:
   1. `bun scripts/repoint-org-plane.ts --mapping map.json --write`
   2. `wrangler secret put SUPERWITNESS_REPORTER_CREDENTIAL` (the plane `svc_` credential)
   3. `wrangler secret put SESSION_SECRET` with a **new** value. This ends every GitHub-era and hub-era session, so nobody stays in a personal tenant through a 30-day cookie.
   4. Merge the PR that adds the four `ORG_PLANE_*` values to `apps/api/wrangler.jsonc` `vars`. CI deploys it.

   Between steps 1 and 4, hub tokens for re-pointed tenants are refused. That is why this runs in the freeze.
4. **Live checks** (record each output on the P4 card):
   - `curl -s https://app.superpipeline.dev/.well-known/oauth-protected-resource/mcp` names the plane.
   - A browser sign-in lands on the team's existing boards, not an empty workspace.
   - `supi login && supi boards` works.
   - A station agent's token claims and completes a card.
   - The reporter drains: the outbox empties, and superwitness shows the run.
   - `claude mcp add --transport http superpipeline https://app.superpipeline.dev/mcp` completes consent and lists tools. Its discovery fetch must hit the plane's ROOT `/.well-known/oauth-authorization-server`.
   - Switching workspace at the plane, then signing in again, lands on the other workspace's boards. A token's `org` is fixed at consent, so a refresh alone never switches.
   - A token for an org without `superpipeline` gets `product_not_enabled`.
5. **Rollback.**
   1. Revert the vars PR.
   2. `bun scripts/repoint-org-plane.ts --mapping map.json --reverse --write`.
   3. Restore the previous reporter credential.

   Tenants created by first sight during the window keep their `org-plane` mapping and are invisible in hub mode. List them with `SELECT id FROM tenants WHERE external_source = 'org-plane'` before reverting.

- [ ] **Step 6: Full verification and commit**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

```bash
git add apps/api/src/db/repoint-org-plane.ts apps/api/test/repoint-org-plane.test.ts scripts/repoint-org-plane.ts docs/12-deploy.md
git commit -m "feat(api): dry-run-first re-point of hub mappings to the Organization plane, with runbook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Done when (P3, from design §10)

Every task is merged and deployed with `ORG_PLANE_*` unset, production behaviour is unchanged, and the full suite is green. Then, against the **staging plane** (P2's deliverable), a local `wrangler dev` with the four `ORG_PLANE_*` values set passes these:
- browser sign-in as `superpipeline-web`;
- `supi login` + `supi boards`;
- an agent token from the plane's `/api/token/agent` claiming a card;
- an MCP client completing discovery → consent → `tools/list`;
- a service token reading `/v1/boards/:id/runs/:runId/evidence`.

Record each output in the PR that closes P3. P4 then runs the runbook in Task 10.

## Open questions (need an answer before or during P4)

1. **AS issuer vs. token issuer: resolved by the P2 plan.** `iss` is the root for every token, and discovery is at the root `/.well-known/oauth-authorization-server`. Task 5 advertises `[ORG_PLANE_ISSUER]`. The contract's §3.1 text (the `/api/auth`-suffixed discovery path) should be amended to match. Live check in P4: `curl https://accounts.superjackfruit.com/.well-known/oauth-authorization-server` returns `"issuer": "https://accounts.superjackfruit.com"`.
2. **Hub calls from the browser.** The assignee picker calls the hub's `/api/fleet/dispatchable` with the SPA's token. A plane token for this app cannot be spent there (inventory row 5), so after cutover the picker shows nothing. A fix needs the plane to let `superpipeline-web` request `resource=https://hub.agentpod.dev` (a second refresh grant), or a hub route that accepts a service-minted token.
3. **Seats.** First sight makes the first arrival `owner` and later arrivals `member`. Should Superpipeline seats follow the plane's org role (`owner`/`admin`/`member`), which the token does not carry today?
4. **Session lifetime.** A plane sign-in still mints a 30-day session cookie. Suspension or entitlement removal at the plane ends bearer access within 5 minutes, but not that cookie. One option is a shorter session in plane mode, ended when the refresh token is refused.
5. **Humans over MCP** get read tools only. Gate decisions and card queueing over MCP for a person are a product decision, not part of this plan.
6. **Shared fleets.** Personal tenants that linked the same fleet as the team's chosen tenant keep their `agentpod` mapping and become unreachable. Should their boards be moved into the org tenant? (This is a data merge, not part of this plan.)
7. **`supi` and `fleet` sharing one device credential.** The contract's device exchange takes any `audience`, so one `dev_` credential could serve both CLIs. The location and naming of credentials are out of scope (design §11). `supi` keeps its own file until that is decided.
8. **`exp - iat = 300`** is contract §2, but Gate 1 observed 3600 s on OAuth tokens by default. This plan does not enforce the lifetime, because enforcing it would refuse valid tokens if P2's configuration drifted. P2's fixture should pin it.

## Self-review

- **Spec coverage (contract §4, Superpipeline):**
  - verifies with `ORG_PLANE_*`: Tasks 1, 4;
  - maps `org` → tenant with first sight: Tasks 3, 4;
  - checks `aud` and enforces `ent`: Tasks 1, 4, 5;
  - MCP accepts `…/mcp` plane tokens and serves RFC 9728 metadata pointing at the plane: Task 5;
  - hosted app's GitHub login off when `ORG_PLANE_ISSUER` is set: Tasks 6, 7;
  - `supi` login uses §3.2: Task 9.

  Also covered:
  - fixture parity (design §9): Task 2;
  - offline verification (design §9): Task 1;
  - wrong-audience refusal (design §9 security tests): Tasks 1, 4, 5;
  - re-pointing existing data (design §8 step 5): Task 10;
  - the service-to-hub inventory: covered by the table above, with Task 8 handling the one server-side call.
- **Placeholder scan:** every code step carries code. The two hand-run checks (Task 10 Step 4's local runner; post-deploy curls) are operational steps with exact commands, not missing code.
- **Type consistency:**
  - `OrgPlaneConfig.mcpAudience`, `planeClaimsFor(request, cfg, audience)`, `ensureOrgTenant(db, org)` and `provisionOrgHuman(db, tenantId, claims)` → `OrgHuman | null` are used with the same names and shapes in Tasks 3–6.
  - `ReporterConfig.tokenAudience` is introduced and consumed in Task 8 only.
  - `HubStatus.signIn` is produced by Task 6 (server) and consumed by Task 7 (web).
- **Review Focus:** each line has its test:
  - (1) Task 3 "refuses — never captures";
  - (2) Task 3 "exactly ONE tenant" and "exactly one owner";
  - (3) Task 1 "verifies offline" and "refetches exactly once";
  - (4) Task 6 "refreshes through the rotating refresh token";
  - (5) Task 4 "refuses a valid HUB token while plane mode is on, and accepts it again".
