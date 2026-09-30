import { describe, it, expect } from 'vitest';
import { connectMcp, depsFor, initBoard, toolJson, RESEARCH_PIPELINE } from './helpers/mcp';

const AUTH = { tenantId: 'tnt_a', agentId: 'agt_r', capabilities: ['research'] };

describe('MCP tools — registration', () => {
  it('exposes the agent-contract verbs with honest annotations (docs/05 §2)', async () => {
    const client = await connectMcp(depsFor(AUTH));
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    expect([...byName.keys()].sort()).toEqual([
      'superpipeline_add_reference',
      'superpipeline_block',
      'superpipeline_claim_card',
      'superpipeline_complete',
      'superpipeline_fail',
      'superpipeline_get_card',
      'superpipeline_get_run',
      'superpipeline_heartbeat',
      'superpipeline_list_work',
      'superpipeline_post_activity',
      'superpipeline_release',
      'superpipeline_split_card',
      'superpipeline_submit_for_review',
    ]);
    expect(byName.get('superpipeline_list_work')!.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });

    // The annotation table in docs/05 §2 — honest hints so harnesses prompt humans correctly.
    expect(byName.get('superpipeline_get_card')!.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(byName.get('superpipeline_claim_card')!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(byName.get('superpipeline_heartbeat')!.annotations).toMatchObject({ idempotentHint: true });
    expect(byName.get('superpipeline_add_reference')!.annotations).toMatchObject({ idempotentHint: true });
    expect(byName.get('superpipeline_block')!.annotations).toMatchObject({ destructiveHint: true });
    expect(byName.get('superpipeline_fail')!.annotations).toMatchObject({ destructiveHint: true });
    expect(byName.get('superpipeline_release')!.annotations).toMatchObject({ destructiveHint: true });
  });
});

describe('MCP tools — claim & lifecycle', () => {
  it('claims a ready card, returning the run + handoff context the agent needs', async () => {
    await initBoard(AUTH, 'brd_claim', RESEARCH_PIPELINE);
    const setup = depsFor(AUTH).boardStub('brd_claim');
    const created = await setup.createCard({ title: 'Write the post', ownerUserId: 'usr_a' });
    if (!created.ok) throw new Error('seed failed');

    const client = await connectMcp(depsFor(AUTH));
    const res = await client.callTool({ name: 'superpipeline_claim_card', arguments: { boardId: 'brd_claim' } });
    const claim = toolJson(res) as { claimed: boolean; runId?: string; leaseEpoch?: number; card?: { id: string } };

    expect(res.isError).toBeFalsy();
    expect(claim.claimed).toBe(true);
    expect(claim.runId).toMatch(/^run_/);
    expect(claim.card?.id).toBe(created.value.id);
  });

  it('reports no work (not an error) when nothing is claimable', async () => {
    await initBoard(AUTH, 'brd_empty', RESEARCH_PIPELINE);
    const client = await connectMcp(depsFor(AUTH));
    const res = await client.callTool({ name: 'superpipeline_claim_card', arguments: { boardId: 'brd_empty' } });

    expect(res.isError).toBeFalsy();
    expect(toolJson(res)).toEqual({ claimed: false });
  });

  it('completes a run and advances the card to the next stage', async () => {
    await initBoard(AUTH, 'brd_done', RESEARCH_PIPELINE);
    const stub = depsFor(AUTH).boardStub('brd_done');
    await stub.createCard({ title: 'Ship it', ownerUserId: 'usr_a' });

    const client = await connectMcp(depsFor(AUTH));
    const claim = toolJson(await client.callTool({ name: 'superpipeline_claim_card', arguments: { boardId: 'brd_done' } })) as {
      runId: string;
      leaseEpoch: number;
    };
    const res = await client.callTool({
      name: 'superpipeline_complete',
      arguments: { boardId: 'brd_done', runId: claim.runId, leaseEpoch: claim.leaseEpoch, handoff: { summary: 'drafted' } },
    });
    const card = toolJson(res) as { currentStageKey: string; state: string };

    expect(res.isError).toBeFalsy();
    expect(card.currentStageKey).toBe('review');
    expect(card.state).toBe('input-required');
  });

  it('returns isError on a business failure (stale lease) so the model can self-correct', async () => {
    await initBoard(AUTH, 'brd_stale', RESEARCH_PIPELINE);
    const stub = depsFor(AUTH).boardStub('brd_stale');
    await stub.createCard({ title: 'Card', ownerUserId: 'usr_a' });
    const client = await connectMcp(depsFor(AUTH));
    const claim = toolJson(await client.callTool({ name: 'superpipeline_claim_card', arguments: { boardId: 'brd_stale' } })) as {
      runId: string;
      leaseEpoch: number;
    };

    const res = await client.callTool({
      name: 'superpipeline_complete',
      arguments: { boardId: 'brd_stale', runId: claim.runId, leaseEpoch: claim.leaseEpoch + 99 },
    });

    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('STALE_LEASE');
  });
});

describe('MCP tools — run verbs', () => {
  /** Claim the seeded card and return the active run handle. */
  async function claimed(boardId: string) {
    await initBoard(AUTH, boardId, RESEARCH_PIPELINE);
    await depsFor(AUTH).boardStub(boardId).createCard({ title: 'Work', ownerUserId: 'usr_a' });
    const client = await connectMcp(depsFor(AUTH));
    const c = toolJson(await client.callTool({ name: 'superpipeline_claim_card', arguments: { boardId } })) as {
      runId: string;
      leaseEpoch: number;
    };
    return { client, ...c };
  }

  it('post_activity captures usage for metering (docs/07 §6)', async () => {
    const { client, runId, leaseEpoch } = await claimed('brd_usage');
    await client.callTool({
      name: 'superpipeline_post_activity',
      arguments: { boardId: 'brd_usage', runId, leaseEpoch, type: 'action', usage: { model: 'claude-opus-4-8', inputTokens: 0, outputTokens: 0, costUsd: 0.4 } },
    });
    const card = (await depsFor(AUTH).boardStub('brd_usage').getState()).cards[0];
    expect(card?.costUsd).toBeCloseTo(0.4, 6);
  });

  it('heartbeat acknowledges an active lease', async () => {
    const { client, runId, leaseEpoch } = await claimed('brd_hb');
    const res = await client.callTool({ name: 'superpipeline_heartbeat', arguments: { boardId: 'brd_hb', runId, leaseEpoch } });
    expect(res.isError).toBeFalsy();
    expect(toolJson(res)).toEqual({ acknowledged: true });
  });

  it('block removes the card from the queue until it is unblocked', async () => {
    const { client, runId, leaseEpoch } = await claimed('brd_block');
    const res = await client.callTool({
      name: 'superpipeline_block',
      arguments: { boardId: 'brd_block', runId, leaseEpoch, reason: 'waiting on API key' },
    });
    expect(res.isError).toBeFalsy();
    const reclaim = await client.callTool({ name: 'superpipeline_claim_card', arguments: { boardId: 'brd_block' } });
    expect(toolJson(reclaim)).toEqual({ claimed: false });
  });

  it('release returns the card to the queue for another attempt', async () => {
    const { client, runId, leaseEpoch } = await claimed('brd_rel');
    const res = await client.callTool({ name: 'superpipeline_release', arguments: { boardId: 'brd_rel', runId, leaseEpoch } });
    expect(res.isError).toBeFalsy();
    const reclaim = toolJson(await client.callTool({ name: 'superpipeline_claim_card', arguments: { boardId: 'brd_rel' } })) as {
      claimed: boolean;
    };
    expect(reclaim.claimed).toBe(true);
  });

  it('submit_for_review opens an approval gate at a gated agent stage', async () => {
    const BUILD_PIPELINE = [
      { key: 'build', name: 'Build', order: 0, ownerKind: 'capability' as const, owner: 'research', gate: 'approval' as const },
      { key: 'ship', name: 'Ship', order: 1, ownerKind: 'capability' as const, owner: 'ship' },
    ];
    await initBoard(AUTH, 'brd_submit', BUILD_PIPELINE);
    await depsFor(AUTH).boardStub('brd_submit').createCard({ title: 'Build it', ownerUserId: 'usr_a' });
    const client = await connectMcp(depsFor(AUTH));
    const c = toolJson(await client.callTool({ name: 'superpipeline_claim_card', arguments: { boardId: 'brd_submit' } })) as {
      runId: string;
      leaseEpoch: number;
    };
    const res = await client.callTool({
      name: 'superpipeline_submit_for_review',
      arguments: { boardId: 'brd_submit', runId: c.runId, leaseEpoch: c.leaseEpoch, output: { artifact: 'build.zip' } },
    });
    expect(res.isError).toBeFalsy();
    const card = toolJson(res) as { state: string };
    expect(card.state).toBe('input-required');
    expect((await depsFor(AUTH).boardStub('brd_submit').getState()).gates).toHaveLength(1);
  });

  it('get_card returns isError for an unknown card', async () => {
    await initBoard(AUTH, 'brd_gc', RESEARCH_PIPELINE);
    const client = await connectMcp(depsFor(AUTH));
    const res = await client.callTool({ name: 'superpipeline_get_card', arguments: { boardId: 'brd_gc', cardId: 'card_nope' } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('CARD_NOT_FOUND');
  });
});

describe('MCP tools — add_reference', () => {
  async function withCard(boardId: string) {
    await initBoard(AUTH, boardId, RESEARCH_PIPELINE);
    const c = await depsFor(AUTH).boardStub(boardId).createCard({ title: 'Card', ownerUserId: 'usr_a' });
    if (!c.ok) throw new Error('seed');
    return { client: await connectMcp(depsFor(AUTH)), cardId: c.value.id };
  }

  it('auto-enriches a bare GitHub PR url into provider/sourceType/externalId', async () => {
    const { client, cardId } = await withCard('brd_ref_mcp');
    const res = await client.callTool({
      name: 'superpipeline_add_reference',
      arguments: { boardId: 'brd_ref_mcp', cardId, url: 'https://github.com/org/repo/pull/42' },
    });
    expect(res.isError).toBeFalsy();
    expect(toolJson(res)).toMatchObject({
      provider: 'github',
      sourceType: 'pull_request',
      externalId: 'org/repo#42',
      addedBy: 'agent',
    });
  });

  it('is idempotent on (cardId, url)', async () => {
    const { client, cardId } = await withCard('brd_ref_idem');
    const args = { boardId: 'brd_ref_idem', cardId, url: 'https://github.com/org/repo/pull/9' };
    await client.callTool({ name: 'superpipeline_add_reference', arguments: { ...args, title: 'first' } });
    await client.callTool({ name: 'superpipeline_add_reference', arguments: { ...args, title: 'second' } });
    const refs = (await depsFor(AUTH).boardStub('brd_ref_idem').getState()).references;
    expect(refs).toHaveLength(1);
    expect(refs[0]!.title).toBe('second');
  });

  it('returns isError for an unknown card', async () => {
    const { client } = await withCard('brd_ref_nocard');
    const res = await client.callTool({
      name: 'superpipeline_add_reference',
      arguments: { boardId: 'brd_ref_nocard', cardId: 'card_nope', url: 'https://x.y' },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('CARD_NOT_FOUND');
  });
});

/**
 * Whole-branch review, Important: the full wire, not just `board.splitCard` directly (that unit
 * coverage lives in `card-split.test.ts`). `superpipeline_split_card` used to pass `auth.agentId`
 * as the child's `ownerUserId`, so a card split mid-run by an agent came out owned by an `agt_…`
 * id — a construct `getNotifications` cannot resolve back to anyone's feed.
 */
describe('MCP tools — split_card child ownership', () => {
  it('a sub-task created over MCP is owned by the PARENT card\'s human owner, not the calling agent', async () => {
    const boardId = 'brd_split_owner_mcp';
    await initBoard(AUTH, boardId, RESEARCH_PIPELINE);
    const created = await depsFor(AUTH).boardStub(boardId).createCard({ title: 'Parent', ownerUserId: 'usr_parent_mcp' });
    if (!created.ok) throw new Error('seed failed');

    const client = await connectMcp(depsFor(AUTH));
    const claim = toolJson(
      await client.callTool({ name: 'superpipeline_claim_card', arguments: { boardId } }),
    ) as { claimed: boolean };
    expect(claim.claimed).toBe(true);

    const res = await client.callTool({
      name: 'superpipeline_split_card',
      arguments: { boardId, cardId: created.value.id, titles: ['Write the spec'] },
    });
    expect(res.isError).toBeFalsy();
    const split = toolJson(res) as { children: Array<{ ownerUserId: string }> };
    expect(split.children).toHaveLength(1);
    // Not `AUTH.agentId` ('agt_r'). `notify()` files under `owner_user_id`, and
    // `getNotifications` filters on the requesting human — an agent id here means the child's
    // gate, park and overdue notifications reach nobody's feed.
    expect(split.children[0]!.ownerUserId).toBe('usr_parent_mcp');
  });
});
