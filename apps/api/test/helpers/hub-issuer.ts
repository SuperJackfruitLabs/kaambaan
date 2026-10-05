import { env } from 'cloudflare:test';

/**
 * Run `fn` with `HUB_ISSUER` set to `issuer` and the issuer's JWKS URL answered from `jwksBody`;
 * every other fetch goes to the real one. Restores both afterwards.
 */
export async function withIssuer<T>(issuer: string, jwksBody: string, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  (env as unknown as Record<string, unknown>).HUB_ISSUER = issuer;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === `${issuer}/api/auth/jwks`
      ? new Response(jwksBody, { headers: { 'content-type': 'application/json' } })
      : realFetch(input as RequestInfo, init)) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    delete (env as unknown as Record<string, unknown>).HUB_ISSUER;
  }
}
