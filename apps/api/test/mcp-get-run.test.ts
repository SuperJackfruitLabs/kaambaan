/**
 * An agent can read the run it holds, including its lease epoch.
 *
 * `superpipeline_complete` and `superpipeline_block` take `leaseEpoch` — a fencing token the
 * caller must supply, because deriving it server-side would defeat what fencing is for: a
 * superseded holder must not be able to act.
 *
 * So an agent reporting its own outcome needs the epoch, and the obvious place to put it was the
 * prompt. AgentPod's prompt corpus forbids exactly that — *"no rendered prompt leaks a credential,
 * a lease epoch or an AgentPod id"* — on the grounds that a prompt crosses into a harness process
 * and could be echoed back into a transcript the board renders.
 *
 * That rule is older than agents having a credential and it is still right. This is the other way
 * of answering the question: the agent asks for its own run rather than being told.
 */
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { initBoard, RESEARCH_PIPELINE } from './helpers/mcp';

const base = 'https://api.test';
const PROTO = '2025-06-18';
const TOKEN = 'tnt_getrun:agt_g:research';

const headers = () => ({
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
});

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  await SELF.fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }),
  });
  const res = await SELF.fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
  return JSON.parse(body.result?.content?.[0]?.text ?? '{}');
}

describe('superpipeline_get_run', () => {
  it('gives the holder its lease epoch, so it can report its own outcome', async () => {
    const boardId = 'brd_getrun';
    const stub = await initBoard({ tenantId: 'tnt_getrun', agentId: 'agt_g', capabilities: ['research'] }, boardId, RESEARCH_PIPELINE);
    await stub.createCard({ title: 'Read my run', ownerUserId: 'usr_a' });

    const claimed = await call('superpipeline_claim_card', { boardId });
    expect(claimed.claimed, JSON.stringify(claimed)).toBe(true);

    const run = await call('superpipeline_get_run', { boardId, runId: claimed.runId });
    expect(run.run).toMatchObject({ runId: claimed.runId, leaseEpoch: claimed.leaseEpoch });
    // The stage and the card come with it: an agent that just woke up needs to know what it holds
    // before it can decide whether it can finish.
    expect(run.card).toBeDefined();
  });

  it('refuses a run the caller does not hold', async () => {
    const boardId = 'brd_getrun2';
    await initBoard({ tenantId: 'tnt_getrun', agentId: 'agt_g', capabilities: ['research'] }, boardId, RESEARCH_PIPELINE);
    const res = await call('superpipeline_get_run', { boardId, runId: 'run_not_mine' });
    expect(res.error).toBeDefined();
  });
});
