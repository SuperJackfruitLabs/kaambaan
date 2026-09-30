import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function parentOn(board: BoardDO, name: string): Promise<string> {
  await board.init({ id: `brd_${name}`, tenantId: 'tnt_a', name, stages: STAGES });
  const p = await board.createCard({ title: 'Ship supermd v1', ownerUserId: 'usr_a' });
  if (!p.ok) throw new Error(p.message);
  return p.value.id;
}

describe('splitCard', () => {
  it('creates one child per line and links them all to the parent', async () => {
    await runInDurableObject(stubFor('split-basic'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitbasic');
      const r = await board.splitCard(parentId, ['Write the spec', 'Build the parser'], 'usr_a');
      if (!r.ok) throw new Error(r.message);
      expect(r.value.children.map((c) => c.title)).toEqual(['Write the spec', 'Build the parser']);
      expect(r.value.children.every((c) => c.parentCardId === parentId)).toBe(true);

      const parent = (await board.getState()).cards.find((c) => c.id === parentId)!;
      expect(parent.openChildCount).toBe(2);
    });
  });

  it('strips markdown checkbox syntax, so "- [ ] Foo" becomes "Foo"', async () => {
    await runInDurableObject(stubFor('split-md'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitmd');
      const r = await board.splitCard(
        parentId,
        ['- [ ] Write the spec', '- [x] Build the parser', '* Draft the post', '2. Review it'],
        'usr_a',
      );
      if (!r.ok) throw new Error(r.message);
      expect(r.value.children.map((c) => c.title)).toEqual([
        'Write the spec',
        'Build the parser',
        'Draft the post',
        'Review it',
      ]);
    });
  });

  // Regression for a review finding on this task: the shipped regexes used `\s*` (zero-or-more),
  // so the separating space markdown requires after a bullet/checkbox was optional — and a line
  // that merely STARTS with a bullet-like character, but isn't one, got silently mangled. None of
  // these four are markdown lists; every one must survive completely unchanged.
  it('does not mangle a title that merely starts like a bullet, checkbox, or bold marker', async () => {
    await runInDurableObject(stubFor('split-md-not-a-bullet'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitmdnotabullet');
      const r = await board.splitCard(
        parentId,
        ['2.0 launch plan', '1.5x throughput', '-fix the bug', '**bold title**'],
        'usr_a',
      );
      if (!r.ok) throw new Error(r.message);
      expect(r.value.children.map((c) => c.title)).toEqual([
        '2.0 launch plan',
        '1.5x throughput',
        '-fix the bug',
        '**bold title**',
      ]);
    });
  });

  // Regression for a review finding on the Important-1 fix: dropping the pre-trim (so it could no
  // longer eat the checkbox's separating space) also removed the ONLY thing that unwrapped leading
  // whitespace before a marker — and an indented checklist item is the ordinary shape of a nested
  // markdown checklist ("- [ ] parent" with "  - [ ] child" under it), exactly the input this
  // converter exists to eat.
  it('unwraps a bullet/checkbox indented with spaces or a tab — a nested checklist item', async () => {
    await runInDurableObject(stubFor('split-md-indented'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitmdindented');
      const r = await board.splitCard(
        parentId,
        ['  - [ ] task', '\t- [ ] task', '- [ ] Parent task', '  - [ ] Child task'],
        'usr_a',
      );
      if (!r.ok) throw new Error(r.message);
      expect(r.value.children.map((c) => c.title)).toEqual([
        'task',
        'task',
        'Parent task',
        'Child task',
      ]);
    });
  });

  it('ignores blank lines rather than creating untitled cards', async () => {
    await runInDurableObject(stubFor('split-blank'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitblank');
      const r = await board.splitCard(parentId, ['One', '', '   ', '- [ ] ', 'Two'], 'usr_a');
      if (!r.ok) throw new Error(r.message);
      expect(r.value.children.map((c) => c.title)).toEqual(['One', 'Two']);
    });
  });

  it('refuses more than 20 in one call, and creates none of them', async () => {
    await runInDurableObject(stubFor('split-limit'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitlimit');
      const many = Array.from({ length: 21 }, (_, i) => `Item ${i + 1}`);
      const r = await board.splitCard(parentId, many, 'usr_a');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('TOO_MANY_CHILDREN');
        expect(r.message).toContain('20');
      }
      // A refused split leaves nothing behind: partially creating 20 of 21 would be worse than
      // refusing, because the caller cannot tell which succeeded.
      expect((await board.getState()).cards).toHaveLength(1);
    });
  });

  it('refuses when every line is blank, rather than succeeding with nothing', async () => {
    await runInDurableObject(stubFor('split-empty'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitempty');
      const r = await board.splitCard(parentId, ['', '- [ ] '], 'usr_a');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('NOTHING_TO_SPLIT');
    });
  });

  it('is not idempotent, deliberately: calling twice creates two sets', async () => {
    await runInDurableObject(stubFor('split-twice'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splittwice');
      await board.splitCard(parentId, ['One'], 'usr_a');
      await board.splitCard(parentId, ['One'], 'usr_a');
      // De-duplicating by title would silently drop a legitimately repeated sub-task. The tool
      // description tells the agent to call it once; the UI confirms before a second call.
      const parent = (await board.getState()).cards.find((c) => c.id === parentId)!;
      expect(parent.openChildCount).toBe(2);
    });
  });
});

// The REST door (Task 15, `POST /v1/boards/:id/cards/:cardId/split`): the human/web-app path,
// which reaches the same `splitCard` the MCP tool does but over HTTP, authenticated by the
// `resolveHubUser` fallback every human board route already carries.
const dev = (tenant: string, user?: string) => ({
  'X-Tenant-Id': tenant,
  ...(user ? { 'X-User-Id': user } : {}),
  'Content-Type': 'application/json',
});

async function restBoard(tenant: string, user: string): Promise<string> {
  const res = await SELF.fetch('https://api.test/v1/boards', {
    method: 'POST',
    headers: dev(tenant, user),
    body: JSON.stringify({ name: 'Split REST', stages: [{ key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' }] }),
  });
  return (await res.json<{ boardId: string }>()).boardId;
}

describe('POST /v1/boards/:id/cards/:cardId/split — REST', () => {
  it('creates children and returns them, 201', async () => {
    const tenant = 'tnt_split_rest';
    const boardId = await restBoard(tenant, 'usr_r');
    const created = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(tenant, 'usr_r'),
      body: JSON.stringify({ title: 'Parent' }),
    });
    const { card } = await created.json<{ card: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${card.id}/split`, {
      method: 'POST',
      headers: dev(tenant, 'usr_r'),
      body: JSON.stringify({ titles: ['- [ ] Write the spec', 'Build the parser'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ children: Array<{ title: string; parentCardId: string }> }>();
    expect(body.children.map((c) => c.title)).toEqual(['Write the spec', 'Build the parser']);
    expect(body.children.every((c) => c.parentCardId === card.id)).toBe(true);
  });

  it('answers 400 for a non-array titles field, rather than reaching the DO', async () => {
    const tenant = 'tnt_split_rest2';
    const boardId = await restBoard(tenant, 'usr_r');
    const created = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(tenant, 'usr_r'),
      body: JSON.stringify({ title: 'Parent' }),
    });
    const { card } = await created.json<{ card: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${card.id}/split`, {
      method: 'POST',
      headers: dev(tenant, 'usr_r'),
      body: JSON.stringify({ titles: 'not an array' }),
    });
    expect(res.status).toBe(400);
  });

  it('answers 400 for TOO_MANY_CHILDREN, the DO business refusal mapped over REST', async () => {
    const tenant = 'tnt_split_rest3';
    const boardId = await restBoard(tenant, 'usr_r');
    const created = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards`, {
      method: 'POST',
      headers: dev(tenant, 'usr_r'),
      body: JSON.stringify({ title: 'Parent' }),
    });
    const { card } = await created.json<{ card: { id: string } }>();

    const res = await SELF.fetch(`https://api.test/v1/boards/${boardId}/cards/${card.id}/split`, {
      method: 'POST',
      headers: dev(tenant, 'usr_r'),
      body: JSON.stringify({ titles: Array.from({ length: 21 }, (_, i) => `Item ${i + 1}`) }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('TOO_MANY_CHILDREN');
  });
});

// `createChildCard` inherits the parent's `queued_grant` — the fix for a bug this task's own
// self-review surfaced: without it, every child is created with `queued_grant = NULL`, and under
// `ENFORCE_CONTROL_PAIR` (production's default — `wrangler.jsonc`; the suite defaults it off) a
// null grant is unconditionally unclaimable (`grantPermitsAgent(null, …)` in `auth/grant-match.ts`).
// That would make `splitCard`'s tool description false in production: "Each becomes a real card
// that can be claimed separately." These tests exercise enforcement genuinely ON — the reason the
// bug was invisible to `pnpm test` in the first place — following `control-pair-claim.test.ts`'s
// pattern of toggling `ENFORCE_CONTROL_PAIR` per test and clearing it after.
//
// `board.claim({ principalId })` is called directly (DO layer, no REST/JWT) — passing `principalId`
// explicitly bypasses `principalIdFor`'s D1 lookup, so no `agents` row needs registering for this.
const GRANT_STAGES: BoardInit['stages'] = [{ key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' }];
const PRINCIPAL = 'prn_0000000000000000cg01';

describe("createChildCard inherits the parent's queued_grant, so a child is claimable under enforcement", () => {
  afterEach(() => {
    delete (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR;
  });

  it('a child of a granted parent is itself claimable once enforcement is on', async () => {
    await runInDurableObject(stubFor('child-grant-ok'), async (board: BoardDO) => {
      await board.init({ id: 'brd_cg_ok', tenantId: 'tnt_a', name: 'CG', stages: GRANT_STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a', queuedGrant: [PRINCIPAL] });
      if (!p.ok) throw new Error(p.message);
      // `priority: 5` is belt-and-braces, not what makes this deterministic: the moment the child
      // exists, `blockedWhere` excludes the PARENT from `claimableWhere` (an open child blocks its
      // parent from being claimed), so the child is already the only candidate `claim` can pick,
      // regardless of priority ordering.
      const child = await board.createChildCard(p.value.id, { title: 'Child', ownerUserId: 'usr_a', priority: 5 });
      if (!child.ok) throw new Error(child.message);
      expect(child.value.queuedGrant).toEqual([PRINCIPAL]);

      (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR = 'true';
      const claimed = await board.claim({ agentId: 'agt_worker', capabilities: ['writing'], principalId: PRINCIPAL });
      expect(claimed.claimed).toBe(true);
      if (claimed.claimed) expect(claimed.card.id).toBe(child.value.id);
    });
  });

  // Pins the inheritance rather than just the happy path: a parent with NO grant must produce a
  // child that is STILL unclaimable — proving the child's grant tracks the parent's, not "always
  // permitted now". Asserts the side effect SPECIFIC to a grant refusal (the child parks
  // `input-required`), not just `claimed === false` — a capability mismatch, a budget stop, or an
  // uninitialised board would also produce `claimed === false` without exercising this inheritance
  // at all, so that alone would not make this test self-supporting.
  it('a child of an ungranted parent stays unclaimable under enforcement', async () => {
    await runInDurableObject(stubFor('child-grant-none'), async (board: BoardDO) => {
      await board.init({ id: 'brd_cg_none', tenantId: 'tnt_a', name: 'CG2', stages: GRANT_STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' }); // no queuedGrant
      if (!p.ok) throw new Error(p.message);
      const child = await board.createChildCard(p.value.id, { title: 'Child', ownerUserId: 'usr_a', priority: 5 });
      if (!child.ok) throw new Error(child.message);
      expect(child.value.queuedGrant).toBeNull();

      (env as unknown as Record<string, unknown>).ENFORCE_CONTROL_PAIR = 'true';
      const claimed = await board.claim({ agentId: 'agt_worker', capabilities: ['writing'], principalId: PRINCIPAL });
      expect(claimed.claimed).toBe(false);
      const card = (await board.getState()).cards.find((c) => c.id === child.value.id)!;
      expect(card.state).toBe('input-required');
    });
  });
});

// Important 2 from review: `superpipeline_split_card` took `boardId`/`cardId` with no ownership
// check, so any agent holding a `run`-scoped token could split ANY card in the workspace — worse
// than an ordinary unauthorized write, because creating a child makes the target fail
// `blockedWhere`, dropping it out of `claim`/`list_work` until that child resolves. One agent could
// freeze another team's card indefinitely by giving it a child nobody will complete, despite the
// tool description's "the card you are working on" and the scope-table comment's "ITS OWN card" —
// neither was enforced. Fixed by gating on `CardView.delegateAgentId` (the agent whose run
// currently holds the card, stamped by `claim` and cleared when the run ends) when an `agentId` is
// supplied; the human/REST path passes none and is unaffected, matching `denyForeignRun`'s existing
// "no identity to compare, the lease alone authorizes" shape for `DEV_AUTH`.
describe('splitCard is gated to the card the calling agent is working', () => {
  it('an agent can split the card its run owns', async () => {
    await runInDurableObject(stubFor('split-owner-ok'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitownerok');
      const claimed = await board.claim({ agentId: 'agt_owner', capabilities: ['writing'] });
      if (!claimed.claimed) throw new Error('expected the claim to succeed');

      const r = await board.splitCard(parentId, ['Write the spec'], 'usr_a', 'agt_owner');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.children).toHaveLength(1);
    });
  });

  it('an agent cannot split a card owned by a different run, and no children are created', async () => {
    await runInDurableObject(stubFor('split-owner-no'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitownerno');
      const claimed = await board.claim({ agentId: 'agt_owner', capabilities: ['writing'] });
      if (!claimed.claimed) throw new Error('expected the claim to succeed');

      const r = await board.splitCard(parentId, ['Write the spec'], 'usr_a', 'agt_intruder');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('NOT_RUN_OWNER');
      // All-or-nothing, same as the other refusals: only the parent card exists.
      expect((await board.getState()).cards).toHaveLength(1);
    });
  });

  it('the human/REST path (no agentId) is unaffected by the ownership check', async () => {
    await runInDurableObject(stubFor('split-owner-human'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitownerhuman');
      // No claim at all — a person may split an unclaimed card, and passes no `agentId`.
      const r = await board.splitCard(parentId, ['Write the spec'], 'usr_a');
      expect(r.ok).toBe(true);
    });
  });
});
