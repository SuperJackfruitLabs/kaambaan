/** Worker bindings + config (docs/02-architecture.md). */
export interface Env {
  /** D1 catalog — tenants, users, memberships, boards index, agents, agent_tokens (P0). */
  DB: D1Database;
  /** One Board Durable Object instance per (tenant, board) — the live authority (P1). */
  BOARD_DO: DurableObjectNamespace;

  // ----- auth (real human login + agent tokens) -----
  /** HMAC key for signing session cookies (secret). */
  SESSION_SECRET?: string;
  /** GitHub OAuth app credentials (secret) for human sign-in. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Public origin of the app (OAuth redirect + post-login redirect), e.g. https://kaambaan.example.com. */
  APP_URL?: string;
  /**
   * Base URL of the suite's token issuer, e.g. https://hub.agentpod.dev
   * (charter decisions/2026-08-15-one-issuer-and-offline-verification.md).
   *
   * Optional, and absent means the hub-token path is simply off: a standalone
   * board must keep working with no issuer anywhere, which is the same posture
   * the tenant external mapping takes.
   */
  HUB_ISSUER?: string;
  /**
   * This plane's key in the hub's OAuth client registry (`HUB_OAUTH_CLIENTS` on the hub), used by
   * the cross-domain token handoff in `auth/hub-oauth.ts`.
   *
   * Optional, defaulting to `kaambaan`, because it is not a credential and confers nothing: the
   * hub decides whether it knows this client, and one it does not know gets a rendered 400 rather
   * than a code. Only a deployment registered under another name needs to set it.
   */
  HUB_OAUTH_CLIENT_ID?: string;
  /**
   * When "true", the control pair is enforced: a card is only claimable if its
   * recorded `queued_grant` permits the claiming agent
   * (charter decisions/2026-08-13-ecosystem-identity.md, Decision 4).
   *
   * An explicit switch rather than "is any grant recorded", because those differ
   * in the dangerous case — a deployment that MEANT to enforce, whose grants
   * never arrived, would silently enforce nothing. Populate grants first, then
   * switch this on: with it on and nothing recorded, every card parks in
   * input-required, which is correct and is also an outage.
   */
  ENFORCE_CONTROL_PAIR?: string;
  /** When "true", accept dev-mode X-Tenant-Id / X-Agent-Id headers (local + tests). Never in prod. */
  DEV_AUTH?: string;
  /** Static web assets (the SPA), served for non-API routes when deployed same-origin. */
  ASSETS?: Fetcher;
}
