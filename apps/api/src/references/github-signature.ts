/**
 * GitHub webhook signature (docs/06 §3, §6): verify `X-Hub-Signature-256` = HMAC-SHA256 of the raw
 * request body under the board's webhook secret, with a constant-time compare. The HMAC primitives
 * are shared with outbound push signing (`src/crypto/hmac.ts`).
 */
import { hmacSha256Hex, hmacSignatureHeader, timingSafeEqualHex } from '../crypto/hmac';

/** Re-exported for tests (and reused when we sign outbound deliveries). */
export const githubSignatureHeader = hmacSignatureHeader;

export async function verifyGithubSignature(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const match = header.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqualHex(match[1]!.toLowerCase(), expected);
}

/**
 * Forgejo webhook signature: `X-Forgejo-Signature`, a BARE hex HMAC-SHA256 of the raw body.
 *
 * Separate from the GitHub verifier rather than one lenient function that accepts either
 * spelling. A verifier that took a bare hex on the GitHub route would weaken that route to let
 * this one reuse it, and the two headers are different claims about who sent the request.
 *
 * Forgejo does send GitHub-compatible `X-GitHub-Event` and `X-GitHub-Delivery` headers, but its
 * signature is its own (`hash_hmac('sha256', payload, secret, false)` in Forgejo's own worked
 * example — `false` being what makes it hex rather than binary, and unprefixed).
 */
export async function verifyForgeSignature(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const candidate = header.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(candidate)) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqualHex(candidate, expected);
}
