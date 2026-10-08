import { describe, it, expect } from 'vitest';
import { connectMcp, depsFor, initBoard, toolJson, RESEARCH_PIPELINE } from './helpers/mcp';

/**
 * The comment tools an agent in a run is offered: read the thread on the card its run holds, and
 * add to it. Both take the RUN, never a card id — the card is derived from the run, so an agent
 * cannot read or post on a card it is not working through these.
 */
const AUTH = { tenantId: 'tnt_mcp_cmt', agentId: 'agt_mc', capabilities: ['research'] };

async function seed(boardId: string) {
  const stub = await initBoard(AUTH, boardId, RESEARCH_PIPELINE);
  const made = await stub.createCard({ title: 'x', ownerUserId: 'usr_a' });
  if (!made.ok) throw new Error('card');
  await stub.addComment({ cardId: made.value.id, author: { kind: 'human', id: 'usr_a', name: 'Asha' }, body: 'check the edge case' });
  const claimed = await stub.claim({ agentId: AUTH.agentId, capabilities: AUTH.capabilities });
  if (!claimed.claimed) throw new Error('claim');
  return { stub, cardId: made.value.id, runId: claimed.runId };
}

describe('superpipeline_list_comments / superpipeline_post_comment', () => {
  it('lists the comments on the run’s card and posts one attributed to the agent', async () => {
    const { runId, cardId } = await seed('brd_mcp_cmt1');
    const client = await connectMcp({ ...depsFor(AUTH), agentName: async () => 'Researcher' });

    const listed = toolJson(await client.callTool({ name: 'superpipeline_list_comments', arguments: { boardId: 'brd_mcp_cmt1', runId } })) as Array<{ body: string }>;
    expect(listed.map((c) => c.body)).toEqual(['check the edge case']);

    const posted = await client.callTool({ name: 'superpipeline_post_comment', arguments: { boardId: 'brd_mcp_cmt1', runId, body: 'Covered it.' } });
    expect(posted.isError).toBeFalsy();
    expect(toolJson(posted)).toMatchObject({ cardId, body: 'Covered it.', author: { kind: 'agent', id: AUTH.agentId, name: 'Researcher' } });
  });

  it('refuses a run that belongs to another agent, on both tools', async () => {
    const { runId } = await seed('brd_mcp_cmt2');
    const intruder = { ...AUTH, agentId: 'agt_other' };
    const client = await connectMcp(depsFor(intruder));
    const l = await client.callTool({ name: 'superpipeline_list_comments', arguments: { boardId: 'brd_mcp_cmt2', runId } });
    const p = await client.callTool({ name: 'superpipeline_post_comment', arguments: { boardId: 'brd_mcp_cmt2', runId, body: 'hi' } });
    expect(l.isError).toBe(true);
    expect(p.isError).toBe(true);
    expect(toolJson(p)).toMatchObject({ error: { code: 'NOT_RUN_OWNER' } });
  });

  it('refuses to post once the run has ended', async () => {
    const { stub, runId } = await seed('brd_mcp_cmt3');
    const run = await stub.getRunContext({ runId, agentId: AUTH.agentId });
    if (!run.ok) throw new Error('ctx');
    await stub.release({ runId, leaseEpoch: run.value.run.leaseEpoch, agentId: AUTH.agentId });
    const client = await connectMcp(depsFor(AUTH));
    const p = await client.callTool({ name: 'superpipeline_post_comment', arguments: { boardId: 'brd_mcp_cmt3', runId, body: 'late' } });
    expect(toolJson(p)).toMatchObject({ error: { code: 'NO_RUN_ON_CARD' } });
  });

  it('is not offered to a token without the run scope', async () => {
    const client = await connectMcp(depsFor({ ...AUTH, scopes: ['read'] }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('superpipeline_list_comments');
    expect(names).not.toContain('superpipeline_post_comment');
  });
});
