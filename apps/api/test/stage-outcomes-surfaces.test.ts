import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { createAgent, createAgentToken } from '../src/db/catalog';
import { connectMcp, depsFor, initBoard, toolJson } from './helpers/mcp';
import type { BoardInit } from '../src/board/board-do';
import { SuperpipelineAgent } from '@superpipeline/agent-sdk';

/**
 * The outcome of a turn reaches the board over both wires an agent has — MCP and REST — and the
 * return stage can be set over the stage PATCH. A field only one surface forwards is a field the
 * other surface's agents can never say (`contract-boundary omissions`), so each is driven here.
 */

beforeAll(setupCatalog);

const STAGES: BoardInit['stages'] = [
  { key: 'fix', name: 'Fix', order: 0, ownerKind: 'capability', owner: 'fix' },
  { key: 'integrate', name: 'Integrate', order: 1, ownerKind: 'capability', owner: 'integrate', returnStage: 'fix' },
  { key: 'done', name: 'Done', order: 2, ownerKind: 'human' },
];

describe('MCP — superpipeline_complete carries the outcome', () => {
  const AUTH = { tenantId: 'tnt_outmcp', agentId: 'agt_judge', capabilities: ['integrate'] };

  async function judgeClaim(boardId: string) {
    const stub = await initBoard(AUTH, boardId, STAGES);
    const created = await stub.createCard({ title: 'Ship it', ownerUserId: 'usr_a' });
    if (!created.ok) throw new Error(created.message);
    const f = await stub.claim({ agentId: 'agt_fix', capabilities: ['fix'] });
    if (!f.claimed) throw new Error('no claim');
    await stub.complete({ runId: f.runId, leaseEpoch: f.leaseEpoch, agentId: 'agt_fix', handoff: { summary: 'fixed' } });
    const client = await connectMcp(depsFor(AUTH));
    const claim = toolJson(await client.callTool({ name: 'superpipeline_claim_card', arguments: { boardId } })) as {
      runId: string;
      leaseEpoch: number;
    };
    return { stub, client, claim, cardId: created.value.id };
  }

  it('changes-needed sends the card back', async () => {
    const { client, claim } = await judgeClaim('brd_outmcp1');
    const res = await client.callTool({
      name: 'superpipeline_complete',
      arguments: { boardId: 'brd_outmcp1', ...claim, handoff: { verdict: 'unsafe' }, outcome: 'changes-needed', findings: 'drops a column' },
    });
    expect(res.isError).toBeFalsy();
    expect(toolJson(res)).toMatchObject({ currentStageKey: 'fix', state: 'submitted' });
  });

  it('needs-person parks the card on the question', async () => {
    const { client, claim } = await judgeClaim('brd_outmcp2');
    const res = await client.callTool({
      name: 'superpipeline_complete',
      arguments: { boardId: 'brd_outmcp2', ...claim, outcome: 'needs-person', question: 'Approve the sign-in', url: 'https://login.example.test/d' },
    });
    expect(res.isError).toBeFalsy();
    const card = toolJson(res) as { state: string; needsHuman?: { reason: string } };
    expect(card).toMatchObject({ state: 'input-required', needsHuman: { reason: 'question' } });
  });

  it('a malformed outcome is a model-visible error the agent can correct', async () => {
    const { client, claim } = await judgeClaim('brd_outmcp3');
    const res = await client.callTool({ name: 'superpipeline_complete', arguments: { boardId: 'brd_outmcp3', ...claim, outcome: 'changes-needed' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(toolJson(res))).toContain('INVALID_OUTCOME');
  });

  it('the tool tells an agent what each outcome is for', async () => {
    const client = await connectMcp(depsFor(AUTH));
    const tool = (await client.listTools()).tools.find((t) => t.name === 'superpipeline_complete')!;
    expect(tool.description).toMatch(/changes-needed/);
    expect(tool.description).toMatch(/needs-person/);
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['outcome', 'findings', 'question', 'url']),
    );
  });
});

describe('REST — runs/:runId/complete and the stage PATCH', () => {
  const base = 'https://api.test';
  const human = (tenantId: string) => ({ 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json' });

  it('a stage PATCH sets and clears the return stage, and refuses one that is not earlier', async () => {
    const tenantId = 'tnt_outrest1';
    const created = await SELF.fetch(`${base}/v1/boards`, {
      method: 'POST',
      headers: human(tenantId),
      body: JSON.stringify({ name: 'R', stages: STAGES.map(({ returnStage: _r, ...s }) => s) }),
    });
    const { boardId } = (await created.json()) as { boardId: string };
    const patch = (body: unknown) =>
      SELF.fetch(`${base}/v1/boards/${boardId}/stages/integrate`, { method: 'PATCH', headers: human(tenantId), body: JSON.stringify(body) });

    const set = await patch({ returnStage: 'fix' });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { stage: { returnStage?: string } }).stage.returnStage).toBe('fix');
    expect((await patch({ returnStage: 'done' })).status).toBe(400);
    const cleared = await patch({ returnStage: null });
    expect(((await cleared.json()) as { stage: { returnStage?: string } }).stage.returnStage).toBeUndefined();
  });

  it('complete over REST forwards the outcome and findings', async () => {
    const tenantId = 'tnt_outrest2';
    const created = await SELF.fetch(`${base}/v1/boards`, { method: 'POST', headers: human(tenantId), body: JSON.stringify({ name: 'R', stages: STAGES }) });
    const { boardId } = (await created.json()) as { boardId: string };
    await SELF.fetch(`${base}/v1/boards/${boardId}/cards`, { method: 'POST', headers: human(tenantId), body: JSON.stringify({ title: 'T', ownerUserId: 'usr_a' }) });

    const tokenFor = async (capabilities: string[], name: string) => {
      const agent = await createAgent(env.DB, tenantId, { name, capabilities });
      return (await createAgentToken(env.DB, tenantId, agent.id, ['claim'])).token;
    };
    const auth = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
    const claim = async (t: string) =>
      (await (await SELF.fetch(`${base}/v1/boards/${boardId}/claims`, { method: 'POST', headers: auth(t), body: '{}' })).json()) as {
        runId: string;
        leaseEpoch: number;
      };

    const fixer = await tokenFor(['fix'], 'Fixer');
    const judge = await tokenFor(['integrate'], 'Judge');
    const f = await claim(fixer);
    await SELF.fetch(`${base}/v1/boards/${boardId}/runs/${f.runId}/complete`, {
      method: 'POST',
      headers: auth(fixer),
      body: JSON.stringify({ leaseEpoch: f.leaseEpoch, handoff: { summary: 'fixed' } }),
    });
    const j = await claim(judge);
    const res = await SELF.fetch(`${base}/v1/boards/${boardId}/runs/${j.runId}/complete`, {
      method: 'POST',
      headers: auth(judge),
      body: JSON.stringify({ leaseEpoch: j.leaseEpoch, outcome: 'changes-needed', findings: 'drops a column' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { card: { currentStageKey: string } }).card.currentStageKey).toBe('fix');

    // The SDK carries it too: the fixer parks on a person rather than ending with a link.
    const sdk = new SuperpipelineAgent({ baseUrl: base, boardId, token: fixer, fetch: (url, init) => SELF.fetch(url, init) });
    const work = await sdk.claim();
    if (!work) throw new Error('expected the fixer to claim the returned card');
    const parked = await sdk.complete(work, { progress: 'half' }, { outcome: 'needs-person', question: 'Approve the sign-in', url: 'https://login.example.test/d' });
    expect(parked.ok).toBe(true);
    expect(((await parked.json()) as { card: { state: string } }).card.state).toBe('input-required');
    const parkedCard = (await (await SELF.fetch(`${base}/v1/boards/${boardId}`, { headers: human(tenantId) })).json()) as {
      elicitations: Array<{ id: string }>;
    };
    const answered = await SELF.fetch(`${base}/v1/boards/${boardId}/elicitations/${parkedCard.elicitations[0]!.id}/answer`, {
      method: 'POST',
      headers: human(tenantId),
      body: JSON.stringify({ text: 'done' }),
    });
    expect(answered.status).toBe(200);

    const bad = await claim(fixer);
    const refused = await SELF.fetch(`${base}/v1/boards/${boardId}/runs/${bad.runId}/complete`, {
      method: 'POST',
      headers: auth(fixer),
      body: JSON.stringify({ leaseEpoch: bad.leaseEpoch, outcome: 'shipped' }),
    });
    expect(refused.status).toBe(400);
  });
});
