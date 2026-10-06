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
