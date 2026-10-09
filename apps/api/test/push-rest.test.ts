import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

const T = { 'X-Tenant-Id': 'tnt_push', 'Content-Type': 'application/json' };
const base = 'https://api.test';

async function board(): Promise<string> {
  const b = (await (
    await SELF.fetch(`${base}/v1/boards`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ name: 'P', stages: [{ key: 'build', name: 'Build', order: 0, ownerKind: 'capability', owner: 'build' }] }),
    })
  ).json()) as { boardId: string };
  return b.boardId;
}

describe('REST — push configs (docs/05 §4)', () => {
  it('registers a subscription and queues a delivery when matching work appears', async () => {
    const bid = await board();
    const reg = await SELF.fetch(`${base}/v1/boards/${bid}/push-configs`, {
      method: 'POST',
      headers: { ...T, 'X-Agent-Id': 'agt_b' },
      body: JSON.stringify({ url: 'https://agent.example/hook', token: 's', capabilities: ['build'], events: ['work.available'] }),
    });
    expect(reg.status).toBe(201);
    expect(((await reg.json()) as { configId: string }).configId).toMatch(/^push_/);

    await SELF.fetch(`${base}/v1/boards/${bid}/cards`, { method: 'POST', headers: T, body: JSON.stringify({ title: 'C', ownerUserId: 'usr_a' }) });

    const deliveries = ((await (await SELF.fetch(`${base}/v1/boards/${bid}/push/deliveries`, { headers: T })).json()) as { deliveries: any[] }).deliveries;
    expect(deliveries).toHaveLength(1);
    expect(JSON.parse(deliveries[0].body)).toMatchObject({ event: 'work.available', stageKey: 'build' });
  });

  it('rejects an unknown event with 400', async () => {
    const bid = await board();
    const res = await SELF.fetch(`${base}/v1/boards/${bid}/push-configs`, {
      method: 'POST',
      headers: { ...T, 'X-Agent-Id': 'agt_b' },
      body: JSON.stringify({ url: 'https://agent.example/hook', token: 's', events: ['card.exploded'] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-http(s) url with 400', async () => {
    const bid = await board();
    const res = await SELF.fetch(`${base}/v1/boards/${bid}/push-configs`, {
      method: 'POST',
      headers: { ...T, 'X-Agent-Id': 'agt_b' },
      body: JSON.stringify({ url: 'file:///etc/passwd', token: 's' }),
    });
    expect(res.status).toBe(400);
  });

  it('requires an agent id', async () => {
    const bid = await board();
    const res = await SELF.fetch(`${base}/v1/boards/${bid}/push-configs`, {
      method: 'POST',
      headers: T,
      body: JSON.stringify({ url: 'https://x.example/h', token: 's' }),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * `POST /v1/boards/:id/push-configs` cast its body (`as { url; token; capabilities?; events?
 * }`), then built the call as `{ agentId, ...body }` — `agentId` first, the body spread AFTER it.
 * A body carrying its own `agentId` therefore won the subscription's identity outright, letting a
 * caller register a push config under any agent id it liked while authenticating as a different
 * one via `X-Agent-Id`. Not a privilege escalation (the route is human-authenticated and the
 * header is already caller-asserted), but a live override, not a hypothetical — demonstrated here
 * against an agent-owned stage, where only the config actually registered as the stage's owner may
 * ever be notified.
 */
describe('REST — push-configs: the X-Agent-Id header, not a body `agentId`, decides the subscription identity', () => {
  it('registers the subscription under the header identity even when the body names a different agent', async () => {
    const b = (await (
      await SELF.fetch(`${base}/v1/boards`, {
        method: 'POST',
        headers: T,
        body: JSON.stringify({ name: 'PW', stages: [{ key: 'work', name: 'Work', order: 0, ownerKind: 'agent', owner: 'agt_real' }] }),
      })
    ).json()) as { boardId: string };
    const bid = b.boardId;

    // Authenticates as agt_real via the header; the body tries to register the subscription as a
    // different agent, agt_evil.
    const reg = await SELF.fetch(`${base}/v1/boards/${bid}/push-configs`, {
      method: 'POST',
      headers: { ...T, 'X-Agent-Id': 'agt_real' },
      body: JSON.stringify({ agentId: 'agt_evil', url: 'https://agent.example/hook', token: 's', events: ['work.available'] }),
    });
    expect(reg.status).toBe(201);

    // The 'work' stage is owned by agt_real. A card entering it notifies ONLY a config whose
    // agent id is agt_real. If the body's agentId had won, the config above would be stored under
    // agt_evil, so NO delivery would be queued here.
    await SELF.fetch(`${base}/v1/boards/${bid}/cards`, { method: 'POST', headers: T, body: JSON.stringify({ title: 'C', ownerUserId: 'usr_a' }) });

    const deliveries = ((await (await SELF.fetch(`${base}/v1/boards/${bid}/push/deliveries`, { headers: T })).json()) as { deliveries: any[] }).deliveries;
    expect(deliveries).toHaveLength(1);
  });
});
