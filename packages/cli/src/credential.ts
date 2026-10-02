/**
 * The credential `supi` acts with.
 *
 * A **hub-issued token** — the same one `fleet login` produces. superpipeline verifies it offline
 * against the hub's JWKS, so one sign-in serves both planes; that is what
 * `charter → decisions/2026-08-15-one-issuer-and-offline-verification.md` is for.
 *
 * Resolution order:
 *
 *   1. `$SUPERPIPELINE_TOKEN` — this CLI's own, for a caller that wants them separate
 *   2. `$AGENTPOD_TOKEN` — the hub token, because it IS the credential superpipeline accepts
 *   3. the token cache `fleet login` writes
 *   4. its device credential, exchanged with its recorded issuer when the cache expires
 *
 * **An agent may also drive this CLI, from `$SUPERPIPELINE_AGENT_TOKEN` alone.**
 *
 * This module used to refuse `spa_` tokens outright, on the argument that "an agent is not a person
 * operating a board". That was the operating model until 2026-10-02, when the operator settled the
 * opposite: they do not drive `supi` routinely, agents do, and a coordinator that cannot use the CLI
 * is a commentator — it can describe the board while every actual change waits on a human opening a
 * terminal.
 *
 * What `charter → decisions/2026-08-13-ecosystem-identity.md` Decision 2 protects is unchanged:
 * when a human acts, the human is the actor. So the two credentials are never interchangeable —
 * an agent token is read ONLY from the variable that names it, it outranks a human token because an
 * agent's shell may well carry a leftover one, and a value in the wrong slot is refused rather than
 * honoured. A hub token quietly accepted in the agent slot would act as whoever it names while the
 * caller believed it was acting as an agent, which is how provenance becomes a lie.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";

export const ENV_TOKEN = "SUPERPIPELINE_TOKEN";
export const ENV_HUB_TOKEN = "AGENTPOD_TOKEN";
/**
 * An agent's own `spa_` credential. Separate from `ENV_TOKEN` on purpose: the variable's name is
 * where the caller states which identity it intends to act as, and a mismatch between the name and
 * the token's shape is a mistake worth reporting rather than resolving.
 */
export const ENV_AGENT_TOKEN = "SUPERPIPELINE_AGENT_TOKEN";
/**
 * A FILE holding an agent credential, re-read on every invocation.
 *
 * A station token — the only agent credential that carries a dispatch grant — lives five minutes:
 * "the expiry IS the revocation SLA". So a value baked into a long-lived process's environment is
 * stale within minutes, and something has to keep it fresh. The thing that can is the node-agent,
 * which holds the node credential and mints these on the station's behalf; it writes the file and
 * this reads it each run.
 *
 * A path rather than a value, for the reason agentpod's `OpenClawTokenFile` already gives: "the
 * token is passed as a FILE PATH, never inline — argv is world-readable."
 */
export const ENV_AGENT_TOKEN_FILE = "SUPERPIPELINE_AGENT_TOKEN_FILE";
export const ENV_BASE = "SUPERPIPELINE_URL";

/**
 * This CLI's entry in the hub's OAuth client registry, named on every renewal.
 *
 * The same value `fleet login` authorizes as and `fleetcred.ClientID` sends, because the client is
 * what decides which planes the minted token may be spent at. Three callers must agree on it.
 */
export const FLEET_CLIENT_ID = "apn";

export const DEFAULT_BASE = "https://app.superpipeline.dev";

export interface Credential {
  token: string;
  /** Where it came from, so an error can name the thing to change. */
  source: string;
  /**
   * Which kind of principal this acts as.
   *
   * Carried rather than re-derived from the token's shape at each call site, because the two are
   * routed and renewed differently: a human's token is refreshed from a device credential, an
   * agent's is a long-lived secret with nothing to exchange it for.
   */
  kind: "human" | "agent";
}

/**
 * Is this value an AGENT's credential, and if not, why not?
 *
 * Two shapes are agent credentials and they look nothing alike:
 *
 *   - `spa_…` — superpipeline's own token. Opaque: a random secret with no claims to read, which is
 *     why it cannot carry a dispatch grant and cannot queue work.
 *   - a hub JWT whose `principalKind` is `"agent"` — a STATION token. This is the one that carries
 *     `mayDispatch`, so it is the only credential an agent can queue with.
 *
 * The first cut of this tested the `spa_` PREFIX, which refused the second shape outright — the
 * guard meant to stop a human's token being used as an agent's also blocked the only credential
 * that could do the job. The discriminator was never the prefix; it is the claim.
 *
 * Returns the reason on refusal, so each caller can name the slot in its own message.
 */
function agentCredentialRefusal(value: string): string | null {
  if (value.startsWith("spa_")) return null;
  const claims = inspect(value);
  if (!claims) {
    return "it is neither a superpipeline agent token (spa_…) nor a token this can read";
  }
  if (claims.principalKind !== "agent") {
    return `it names a ${claims.principalKind || "unknown"} principal, not an agent — such a token would act as whoever it names`;
  }
  return null;
}

/** Match Go os.UserConfigDir(), used by fleet on every supported platform. */
export function fleetConfigDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "agentpod");
  if (platform === "win32") {
    if (!process.env.APPDATA) throw new Error("APPDATA is not set; cannot locate fleet credentials.");
    return join(process.env.APPDATA, "agentpod");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentpod");
}

function fleetTokenPath(): string {
  return join(fleetConfigDir(), "token.json");
}

export function loadCredential(): Credential | null {
  /**
   * The token FILE first, because it is the only slot anything keeps fresh.
   *
   * Named but unreadable is a REFUSAL, never a fall-through. A refresher that stopped writing would
   * otherwise send this straight down to a human slot, and the agent would act as the operator —
   * indistinguishably, which is the exact failure `queued_by_agent_id` and this whole precedence
   * order exist to prevent. A broken refresher must read as broken.
   */
  const tokenFile = (process.env[ENV_AGENT_TOKEN_FILE] ?? "").trim();
  if (tokenFile !== "") {
    let raw: string;
    try {
      raw = readFileSync(tokenFile, "utf8");
    } catch {
      throw new Error(
        `${ENV_AGENT_TOKEN_FILE} names ${tokenFile}, which could not be read. ` +
          `Refusing rather than falling back to another credential: that would act as somebody else.`,
      );
    }
    const token = raw.trim();
    if (token === "") {
      throw new Error(
        `${ENV_AGENT_TOKEN_FILE} names ${tokenFile}, which is empty — a refresher that produced nothing. ` +
          `Refusing rather than falling back to another credential.`,
      );
    }
    const refusal = agentCredentialRefusal(token);
    if (refusal) throw new Error(`${tokenFile} does not hold an agent credential: ${refusal}.`);
    return { token, source: `file:${tokenFile}`, kind: "agent" };
  }

  // Then the environment slot: a station's shell can hold a leftover hub token from `fleet login`,
  // and if that won the agent would act as the operator — indistinguishably.
  const agentToken = (process.env[ENV_AGENT_TOKEN] ?? "").trim();
  if (agentToken !== "") {
    const refusal = agentCredentialRefusal(agentToken);
    if (refusal) {
      throw new Error(
        `${ENV_AGENT_TOKEN} does not hold an agent credential: ${refusal}. ` +
          `A person's token belongs in ${ENV_TOKEN}.`,
      );
    }
    return { token: agentToken, source: `env:${ENV_AGENT_TOKEN}`, kind: "agent" };
  }
  for (const name of [ENV_TOKEN, ENV_HUB_TOKEN]) {
    const v = (process.env[name] ?? "").trim();
    if (v === "") continue;
    if (v.startsWith("spa_")) {
      throw new Error(
        `${name} holds an agent token (spa_…), which names an agent rather than a person. ` +
          `Set ${ENV_AGENT_TOKEN} instead, so what acts is what the board records.`,
      );
    }
    return { token: v, source: `env:${name}`, kind: "human" };
  }
  try {
    const raw = JSON.parse(readFileSync(fleetTokenPath(), "utf8")) as { token?: string };
    if (typeof raw?.token === "string" && raw.token.trim() !== "") {
      // `fleet login` writes a human's token. An agent never arrives through this file.
      return { token: raw.token.trim(), source: fleetTokenPath(), kind: "human" };
    }
  } catch {
    // Absent or unreadable is simply "no credential". Nothing else is tried.
  }
  return null;
}

/** Resolve locally first. Explicit environment credentials never change identity silently. */
export async function resolveCredential(): Promise<Credential | null> {
  const cached = loadCredential();
  // An agent credential is returned as-is and never renewed: there is no device to exchange, and
  // the renewal path below would mint a HUMAN token, silently changing who is acting.
  if (cached?.kind === "agent") return cached;
  if (cached?.source.startsWith("env:")) return cached;
  const claims = cached ? inspect(cached.token) : null;
  if (claims?.expiry && !expired(claims)) return cached;

  let device: { id?: unknown; secret?: unknown; hub?: unknown } | null;
  const devicePath = join(fleetConfigDir(), "device.json");
  try {
    device = JSON.parse(readFileSync(devicePath, "utf8"));
  } catch {
    return cached;
  }
  if (typeof device?.id !== "string" || !device.id.trim() ||
      typeof device.secret !== "string" || !device.secret.trim()) return cached;

  // The long-lived secret goes only to the issuer recorded by fleet login, never to
  // SUPERPIPELINE_URL, a JWT claim, or a redirected host. Local development can use HTTP.
  let issuer: URL;
  try {
    issuer = new URL(typeof device.hub === "string" ? device.hub : "");
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname);
    if ((issuer.protocol !== "https:" && !(issuer.protocol === "http:" && loopback)) ||
        issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error();
  } catch {
    throw new Error("The device has no safe issuer. Run fleet login again.");
  }
  const hub = issuer.href.replace(/\/+$/, "");
  let response: Response;
  try {
    // `client=apn` — the registry entry `fleet login` authorizes as, and the one
    // `fleetcred.ExchangeDevice` sends on its own renewals.
    //
    // Without it the hub mints for ITSELF alone, so a renewal produced a narrower token than the
    // sign-in it renewed: accepted by the hub, refused here. `supi boards` answered 401 while
    // `supi whoami` looked perfect, because whoami never leaves the machine. Which planes a token
    // may be spent at is declared per client in the hub's registry (`OAuthClient.audiences`), and
    // naming the client is how a caller asks for them.
    //
    // `client`, not `client_id`: the hub reads the former, and answers the latter as "unknown
    // client" — a refusal that reads like a registry problem and is a spelling one.
    response = await fetch(`${hub}/api/auth/devices/token?client=${encodeURIComponent(FLEET_CLIENT_ID)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${device.id}:${device.secret}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // Fetch errors can contain request details. Do not print secrets or server bodies.
    throw new Error("Could not renew the fleet token. Check the hub connection and try again.");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Could not renew the fleet token: the hub refused this device. Run fleet login again.");
    }
    throw new Error(`Could not renew the fleet token (HTTP ${response.status}). Try again later.`);
  }
  let token: unknown;
  try {
    token = (await response.json())?.token;
  } catch {
    throw new Error("Could not renew the fleet token: the hub returned an invalid response.");
  }
  const renewed = typeof token === "string" ? inspect(token) : null;
  if (typeof token !== "string" || !renewed?.expiry || expired(renewed)) {
    throw new Error("Could not renew the fleet token: the hub returned an unusable token.");
  }

  // Atomic, private cache replacement; never touch the long-lived device file.
  // A read-only cache must not invalidate an otherwise successful exchange.
  let staging: string | undefined;
  try {
    staging = mkdtempSync(join(fleetConfigDir(), ".supi-token-"));
    const path = join(staging, "token.json");
    writeFileSync(path, JSON.stringify({ token, hub }), { mode: 0o600 });
    renameSync(path, fleetTokenPath());
  } catch {
    // Best effort, as in fleet itself. The command can still use the fresh token.
  } finally {
    if (staging) {
      try { rmSync(staging, { recursive: true, force: true }); } catch { /* Best-effort cleanup. */ }
    }
  }
  // A device exchange always mints a HUMAN token: the device belongs to a person who ran `fleet
  // login`. An agent credential never reaches this path — `resolveCredential` returns it before here.
  return { token, source: devicePath, kind: "human" };
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
 * This is not an authorization decision: whoami displays the claims and renewal checks expiry.
 * Superpipeline verifies the token; a client that
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
      expiry: typeof payload.exp === "number" && Number.isFinite(payload.exp) && Number.isFinite(new Date(payload.exp * 1000).getTime())
        ? new Date(payload.exp * 1000) : null,
    };
  } catch {
    return null;
  }
}

export function expired(c: Claims): boolean {
  return c.expiry !== null && c.expiry.getTime() <= Date.now();
}

/**
 * What a credential says about itself, for `whoami`.
 *
 * An agent's `spa_` token is opaque — it is a random secret, not a JWT, and the agent it names lives
 * in superpipeline's catalog rather than in the string. So `principal` is null, and that is a fact
 * rather than a failure: before this, `whoami` on an agent credential answered "The stored
 * credential is not a token this can read", which reads like a broken credential and described a
 * working one.
 *
 * Null is reserved for a HUMAN credential that genuinely cannot be parsed, which the caller should
 * still refuse.
 */
export function describeCredential(c: Credential): {
  principal: string | null;
  kind: string;
  source: string;
  expires: string | null;
} | null {
  if (c.kind === "agent") {
    // A STATION token is a JWT and says both. An `spa_` token is an opaque secret and says neither,
    // and reporting that as a fact beats reporting it as a failure — which is what this did before
    // it distinguished the two.
    const claims = inspect(c.token);
    if (claims) {
      return {
        principal: claims.subject || null,
        kind: claims.principalKind || "agent",
        source: c.source,
        expires: claims.expiry?.toISOString() ?? null,
      };
    }
    return { principal: null, kind: "agent", source: c.source, expires: null };
  }
  const claims = inspect(c.token);
  if (!claims) return null;
  return {
    principal: claims.subject,
    kind: claims.principalKind,
    source: c.source,
    expires: claims.expiry?.toISOString() ?? null,
  };
}

/**
 * What to tell someone refused with a 403, given what is holding the credential.
 *
 * Two different dead ends wear the same status code. A PERSON is refused by their role, and the
 * remedy is their seat or an unlinked account. An AGENT is refused by its token's scopes or by what
 * its operator permitted it, and none of the human advice is actionable by it.
 *
 * Observed live: a coordinator holding a `read`-scoped token was refused card creation with `this
 * token is not permitted to queue` — correctly — and then advised to "sign in once at the web app".
 * An error that sends somebody looking in the wrong place costs more than no error at all.
 */
export function refusalHint(kind: Credential["kind"]): string {
  if (kind === "agent") {
    return (
      "This agent token does not permit that.\n" +
      "Reading a board needs the `read` scope; creating a card needs `queue` — a token minted\n" +
      "without them is refused here rather than at claim time. What an agent may queue, and onto\n" +
      "which boards, is also set per agent: `supi agent queueing <agentId>`."
    );
  }
  return (
    "Your seat in this workspace does not permit that.\n" +
    "An AgentPod identity reads as `member` until it is linked to a superpipeline account —\n" +
    "sign in once at the web app with the same address to link them. See packages/cli/README.md."
  );
}
