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
