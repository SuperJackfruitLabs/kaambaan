/**
 * The credential `kbn` acts with.
 *
 * A **hub-issued token** — the same one `apn fleet login` produces. kaambaan verifies it offline
 * against the hub's JWKS, so one sign-in serves both planes; that is what
 * `charter → decisions/2026-08-15-one-issuer-and-offline-verification.md` is for.
 *
 * Resolution order, and nothing else is ever consulted:
 *
 *   1. `$KAAMBAAN_TOKEN` — this CLI's own, for a caller that wants them separate
 *   2. `$AGENTPOD_TOKEN` — the hub token, because it IS the credential kaambaan accepts
 *   3. the file `apn fleet login` writes
 *
 * **It never reads a `kbn_` agent token.** Those name an agent, and an agent is not a person
 * operating a board: it claims work through the MCP server or the REST verbs with its own
 * identity. A CLI that silently acted as an agent would attribute a human's decisions to one,
 * which is the distinction `charter → decisions/2026-08-13-ecosystem-identity.md` Decision 2
 * exists to protect — when a human acts, the human is the actor.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const ENV_TOKEN = "KAAMBAAN_TOKEN";
export const ENV_HUB_TOKEN = "AGENTPOD_TOKEN";
export const ENV_BASE = "KAAMBAAN_URL";

export const DEFAULT_BASE = "https://app.kaambaan.dev";

export interface Credential {
  token: string;
  /** Where it came from, so an error can name the thing to change. */
  source: string;
}

/** Where `apn fleet login` stores its token. Read, never written — `kbn` does not sign in. */
function apnTokenPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config");
  return join(base, "agentpod", "token.json");
}

export function loadCredential(): Credential | null {
  for (const name of [ENV_TOKEN, ENV_HUB_TOKEN]) {
    const v = (process.env[name] ?? "").trim();
    if (v !== "") return { token: v, source: `env:${name}` };
  }
  try {
    const raw = JSON.parse(readFileSync(apnTokenPath(), "utf8")) as { token?: string };
    if (raw.token && raw.token.trim() !== "") {
      return { token: raw.token.trim(), source: apnTokenPath() };
    }
  } catch {
    // Absent or unreadable is simply "no credential". Nothing else is tried.
  }
  return null;
}

export function baseUrl(): string {
  const v = (process.env[ENV_BASE] ?? "").trim();
  return (v !== "" ? v : DEFAULT_BASE).replace(/\/+$/, "");
}

export interface Claims {
  subject: string;
  principalKind: string;
  expiry: Date | null;
}

/**
 * Read a JWT's payload without verifying it.
 *
 * Correct here, and worth stating because it looks wrong: this is not an authorization decision.
 * It is `whoami` telling an operator what they are carrying. kaambaan verifies; a client that
 * pre-empts the server's decision is a client that will one day disagree with it.
 */
export function inspect(token: string): Claims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      sub?: string;
      principalKind?: string;
      exp?: number;
    };
    return {
      subject: payload.sub ?? "",
      principalKind: payload.principalKind ?? "",
      expiry: payload.exp ? new Date(payload.exp * 1000) : null,
    };
  } catch {
    return null;
  }
}

export function expired(c: Claims): boolean {
  return c.expiry !== null && c.expiry.getTime() < Date.now();
}
