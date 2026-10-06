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
