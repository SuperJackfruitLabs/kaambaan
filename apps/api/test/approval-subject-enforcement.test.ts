import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Stage } from '@superpipeline/contract';
import { BoardDO, type BoardInit, type Result } from '../src/board/board-do';

/**
 * Regression target: a production change that accepts a bound approval without the exact stored
 * subject, its digest, and an allow-listed human must fail these tests before any publisher can
 * treat that approval as authority. All values are generic fixtures; no live account or board data
 * belongs in this product test.
 */
const DECIDER = 'usr_fixture_decider';
const OTHER_HUMAN = 'usr_fixture_other';
const PRODUCER = 'agt_fixture_writer';
const PUBLISHER = 'agt_fixture_publisher';
const ACCOUNT = { platform: 'x', userId: 'acct_fixture_1', username: 'fixture_account' };

const STAGES = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
  {
    key: 'approve',
    name: 'Approve exact payload',
    order: 1,
    ownerKind: 'human',
    gate: 'approval',
    approvalSubjectSchema: 'social-publish/v1',
    approvalDeciderPrincipalIds: [DECIDER],
  },
  { key: 'publish', name: 'Publish', order: 2, ownerKind: 'capability', owner: 'x-publish' },
  { key: 'recorded', name: 'Recorded', order: 3, ownerKind: 'human' },
] as BoardInit['stages'];

function payload(expiresAt = '2030-01-02T03:04:05Z') {
  return {
    channel: 'x',
    account: ACCOUNT,
    items: [
      {
        index: 0,
        text: 'Exact fixture text — spacing and Unicode stay unchanged.\nSecond line.',
        media: [
          {
            objectRef: 'immutable://fixture/media-1',
            sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            mime: 'image/png',
            size: 12345,
            altText: 'A generic fixture image',
            rightsRef: 'evidence://fixture/rights-1',
          },
        ],
        replyToPostId: null,
        quotePostId: null,
      },
    ],
    timing: { mode: 'immediate', notBefore: null, expiresAt },
    evidenceRefs: ['https://example.invalid/evidence/fixture-1'],
    policy: {
      allowThread: true,
      duplicatePolicyId: 'fixture-duplicate-policy',
      floodPolicyId: 'fixture-flood-policy',
    },
  };
}

type SubjectRow = {
  id: string;
  digest: string;
  status: string;
  canonical_bytes: ArrayBuffer | ArrayBufferView | string;
};

type GateRow = {
  id: string;
  status: string;
  approval_subject_id: string;
  approval_subject_digest: string;
};

function utf8(value: SubjectRow['canonical_bytes']): string {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  return new TextDecoder().decode(value);
}

function base64(value: SubjectRow['canonical_bytes']): string {
  const bytes =
    typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function openBoundGate(
  board: BoardDO,
  state: DurableObjectState,
  suffix: string,
  options: {
    stages?: BoardInit['stages'];
    projectId?: string | null;
    publicationPayload?: unknown;
    boardId?: string;
    tenantId?: string;
  } = {},
) {
  await board.init({
    id: options.boardId ?? `brd_fixture_${suffix}`,
    tenantId: options.tenantId ?? 'tnt_fixture',
    name: 'Fixture board',
    stages: options.stages ?? STAGES,
  });
  const made = await board.createCard({
    title: 'Sanitized approval fixture',
    ownerUserId: 'usr_fixture_owner',
    projectId: options.projectId === undefined ? 'prj_fixture' : options.projectId ?? undefined,
  });
  if (!made.ok) throw new Error(made.message);
  const claim = await board.claim({ agentId: PRODUCER, capabilities: ['writing'] });
  if (!claim.claimed) throw new Error('fixture draft was not claimable');
  const completed = await board.complete({
    runId: claim.runId,
    leaseEpoch: claim.leaseEpoch,
    handoff: { publicationPayload: options.publicationPayload ?? payload() } as never,
  });
  if (!completed.ok) throw new Error(completed.message);
  const subject = state.storage.sql.exec('SELECT * FROM approval_subjects WHERE card_id = ?', made.value.id).one() as SubjectRow;
  const gate = state.storage.sql.exec('SELECT * FROM gates WHERE card_id = ?', made.value.id).one() as GateRow;
  return { cardId: made.value.id, producerRunId: claim.runId, subject, gate };
}

function boundDecision(gate: GateRow, subject: SubjectRow, decidedBy = DECIDER) {
  return {
    gateId: gate.id,
    decision: 'approve' as const,
    decidedBy,
    approvalSubjectId: subject.id,
    approvalSubjectDigest: subject.digest,
  };
}

function auth(tenantId: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'X-Tenant-Id': tenantId, 'Content-Type': 'application/json', ...extra };
}

describe('approval-subject stage contract', () => {
  it('round-trips opt-in fields through the real stage route and the shared Stage schema', async () => {
    const tenantId = 'tnt_subject_stage_contract';
    const made = await SELF.fetch('https://api.test/v1/boards', {
      method: 'POST',
      headers: auth(tenantId),
      body: JSON.stringify({ name: 'Subject contract fixture', stages: STAGES.slice(0, 2) }),
    });
    expect(made.status).toBe(201);
    const { boardId } = await made.json<{ boardId: string }>();

    const replaced = await SELF.fetch(`https://api.test/v1/boards/${boardId}/stages`, {
      method: 'PUT',
      headers: auth(tenantId),
      body: JSON.stringify({ stages: STAGES }),
    });
    expect(replaced.status).toBe(200);

    const read = await SELF.fetch(`https://api.test/v1/boards/${boardId}`, { headers: auth(tenantId) });
    const snapshot = await read.json<{ stages: unknown[] }>();
    const approval = Stage.parse(snapshot.stages.find((candidate) => (candidate as { key?: string }).key === 'approve')) as
      | ReturnType<typeof Stage.parse>
      | { approvalSubjectSchema?: string; approvalDeciderPrincipalIds?: string[] };
    expect(approval).toMatchObject({
      approvalSubjectSchema: 'social-publish/v1',
      approvalDeciderPrincipalIds: [DECIDER],
    });
  });
});

describe('approval-subject creation refuses bad input without mutating the run', () => {
  const cases: Array<{
    name: string;
    stages?: BoardInit['stages'];
    projectId?: string | null;
    handoff?: unknown;
  }> = [
    {
      name: 'unknown schema',
      stages: STAGES.map((stage) => (stage.key === 'approve' ? { ...stage, approvalSubjectSchema: 'unknown/v1' } : stage)),
    },
    {
      name: 'empty decider allowlist',
      stages: STAGES.map((stage) => (stage.key === 'approve' ? { ...stage, approvalDeciderPrincipalIds: [] } : stage)),
    },
    { name: 'missing project', projectId: null },
    { name: 'missing publication payload', handoff: {} },
    {
      name: 'schema-invalid publication payload',
      handoff: { publicationPayload: { channel: 'x', account: ACCOUNT, items: [] } },
    },
  ];

  it.each(cases)('returns a typed 4xx-ready Result for $name before any write', async ({ name, stages, projectId, handoff }) => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`approval-refusal-${name}`)) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      await board.init({ id: `brd_refusal_${name}`, tenantId: 'tnt_fixture', name: 'Refusal fixture', stages: stages ?? STAGES });
      const made = await board.createCard({
        title: 'Refusal fixture',
        ownerUserId: 'usr_fixture_owner',
        projectId: projectId === undefined ? 'prj_fixture' : projectId ?? undefined,
      });
      if (!made.ok) throw new Error(made.message);
      const claim = await board.claim({ agentId: PRODUCER, capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('fixture draft was not claimable');

      const completion = board.complete({
        runId: claim.runId,
        leaseEpoch: claim.leaseEpoch,
        handoff: (handoff ?? { publicationPayload: payload() }) as never,
      });
      await expect(completion).resolves.toMatchObject({ ok: false, code: 'INVALID_APPROVAL_SUBJECT' });

      expect(state.storage.sql.exec('SELECT id FROM approval_subjects').toArray()).toHaveLength(0);
      expect(state.storage.sql.exec('SELECT id FROM gates').toArray()).toHaveLength(0);
      expect(state.storage.sql.exec('SELECT status FROM runs WHERE id = ?', claim.runId).one()).toEqual({ status: 'working' });
      expect(state.storage.sql.exec('SELECT current_stage_key FROM cards WHERE id = ?', made.value.id).one()).toEqual({
        current_stage_key: 'draft',
      });
    });
  });
});

describe('approval-subject completion is race-safe and atomic', () => {
  it('allows only one of two concurrent completions to advance the same fenced run', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-concurrent-complete')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      await board.init({ id: 'brd_concurrent', tenantId: 'tnt_fixture', name: 'Concurrent fixture', stages: STAGES });
      const made = await board.createCard({ title: 'Concurrent fixture', ownerUserId: 'usr_fixture_owner', projectId: 'prj_fixture' });
      if (!made.ok) throw new Error(made.message);
      const claim = await board.claim({ agentId: PRODUCER, capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('fixture draft was not claimable');
      const input = { runId: claim.runId, leaseEpoch: claim.leaseEpoch, handoff: { publicationPayload: payload() } as never };

      const settled = await Promise.allSettled([board.complete(input), board.complete(input)]);
      expect(settled.every((entry) => entry.status === 'fulfilled')).toBe(true);
      const results = settled.map((entry) => (entry as PromiseFulfilledResult<Result<unknown>>).value);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok && result.code === 'STALE_LEASE')).toHaveLength(1);
      expect(state.storage.sql.exec('SELECT id FROM approval_subjects').toArray()).toHaveLength(1);
      expect(state.storage.sql.exec('SELECT id FROM gates').toArray()).toHaveLength(1);
    });
  });

  it('rolls subject, gate and active pointer back together when gate insertion fails', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-transaction-rollback')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      await board.init({ id: 'brd_rollback', tenantId: 'tnt_fixture', name: 'Rollback fixture', stages: STAGES });
      const made = await board.createCard({ title: 'Rollback fixture', ownerUserId: 'usr_fixture_owner', projectId: 'prj_fixture' });
      if (!made.ok) throw new Error(made.message);
      const claim = await board.claim({ agentId: PRODUCER, capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('fixture draft was not claimable');
      state.storage.sql.exec(`CREATE TRIGGER fixture_abort_gate BEFORE INSERT ON gates BEGIN SELECT RAISE(ABORT, 'fixture gate failure'); END`);

      await expect(
        board.complete({ runId: claim.runId, leaseEpoch: claim.leaseEpoch, handoff: { publicationPayload: payload() } }),
      ).rejects.toThrow('fixture gate failure');
      expect(state.storage.sql.exec('SELECT id FROM approval_subjects').toArray()).toHaveLength(0);
      expect(state.storage.sql.exec('SELECT active_approval_subject_id FROM cards WHERE id = ?', made.value.id).one()).toEqual({
        active_approval_subject_id: null,
      });
      expect(
        state.storage.sql
          .exec('SELECT status, outcome, ended_at, handoff_json, completion FROM runs WHERE id = ?', claim.runId)
          .one(),
      ).toEqual({
        status: 'working',
        outcome: null,
        ended_at: null,
        handoff_json: null,
        completion: null,
      });
      expect(state.storage.sql.exec('SELECT current_stage_key, state, current_run_id FROM cards WHERE id = ?', made.value.id).one()).toEqual({
        current_stage_key: 'draft',
        state: 'working',
        current_run_id: claim.runId,
      });
    });
  });
});

describe('bound gate resolution', () => {
  it.each([
    { name: 'a human outside the snapshot', actor: OTHER_HUMAN },
    { name: 'an agent caller', actor: 'agt_fixture_decider' },
  ])('refuses $name without resolving or advancing', async ({ name, actor }) => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`approval-decider-${name}`)) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, name);
      const result = await board.resolveGate(boundDecision(opened.gate, opened.subject, actor) as never);
      expect(result).toMatchObject({ ok: false, code: 'APPROVAL_DECIDER_NOT_ALLOWED' });
      expect(state.storage.sql.exec('SELECT status FROM gates WHERE id = ?', opened.gate.id).one()).toEqual({ status: 'pending' });
      expect(state.storage.sql.exec('SELECT current_stage_key FROM cards WHERE id = ?', opened.cardId).one()).toEqual({
        current_stage_key: 'approve',
      });
    });
  });

  it.each([
    { name: 'stale subject id', patch: { approvalSubjectId: 'aps_stale_fixture' } },
    { name: 'wrong digest', patch: { approvalSubjectDigest: `sha256:${'0'.repeat(64)}` } },
  ])('refuses a $name from a stale renderer', async ({ name, patch }) => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`approval-stale-${name}`)) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, name);
      const result = await board.resolveGate({ ...boundDecision(opened.gate, opened.subject), ...patch } as never);
      expect(result).toMatchObject({ ok: false, code: 'APPROVAL_SUBJECT_MISMATCH' });
      expect(state.storage.sql.exec('SELECT status FROM gates WHERE id = ?', opened.gate.id).one()).toEqual({ status: 'pending' });
    });
  });

  it('accepts only the allow-listed human echoing the exact rendered id and digest', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-exact-decision')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'exact');
      const result = await board.resolveGate(boundDecision(opened.gate, opened.subject) as never);
      expect(result).toMatchObject({ ok: true, value: { currentStageKey: 'publish' } });
    });
  });

  it('offers manual and automatic approval as distinct digest-preserving delivery choices', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-delivery-choice')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'delivery');
      const gate = await board.getGate(opened.gate.id);
      expect(gate).toMatchObject({
        ok: true,
        value: {
          options: [
            { name: 'approve_manual', title: "Approve — I'll post it myself" },
            { name: 'approve_automatic', title: 'Approve — post automatically' },
            { name: 'request_changes', title: 'Request changes' },
            { name: 'reject', title: 'Reject' },
          ],
        },
      });
    });
  });

  it.each([
    ['approve_manual', 'approve', 'input-required'],
    ['approve_automatic', 'publish', 'submitted'],
  ] as const)(
    'persists %s as the delivery choice and routes it safely',
    async (decision, currentStageKey, stateName) => {
      const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`approval-delivery-${decision}`)) as unknown as DurableObjectStub<BoardDO>;
      await runInDurableObject(stub, async (board: BoardDO, state) => {
        const opened = await openBoundGate(board, state, decision);
        const result = await board.resolveGate({ ...boundDecision(opened.gate, opened.subject), decision } as never);
        expect(result).toMatchObject({ ok: true, value: { currentStageKey, state: stateName } });
        expect(state.storage.sql.exec('SELECT decision FROM gates WHERE id = ?', opened.gate.id).one()).toEqual({ decision });
        const publisherClaim = await board.claim({ agentId: PUBLISHER, capabilities: ['x-publish'] });
        expect(publisherClaim).toMatchObject({ claimed: decision === 'approve_automatic' });
      });
    },
  );

  it('refuses canonical bytes to an automatic executor after a manual approval even if the card is incorrectly made claimable', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-manual-executor-fence')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'manual-executor-fence');
      const approved = await board.resolveGate({ ...boundDecision(opened.gate, opened.subject), decision: 'approve_manual' } as never);
      expect(approved.ok).toBe(true);

      // Defense in depth: reproduce the unsafe state from integration independently of routing.
      state.storage.sql.exec(
        `UPDATE cards SET current_stage_key = 'publish', state = 'submitted', delegate_agent_id = NULL, current_run_id = NULL WHERE id = ?`,
        opened.cardId,
      );
      const claim = await board.claim({ agentId: PUBLISHER, capabilities: ['x-publish'] });
      if (!claim.claimed) throw new Error('forced publisher fixture was not claimable');
      const verified = await board.verifyApprovalSubject({
        runId: claim.runId,
        leaseEpoch: claim.leaseEpoch,
        agentId: PUBLISHER,
        expectedSchema: 'social-publish/v1',
        expectedSubjectId: opened.subject.id,
        expectedDigest: opened.subject.digest,
        expectedAccount: ACCOUNT,
      });
      expect(verified).toMatchObject({ ok: false, code: 'APPROVAL_SUBJECT_NOT_VERIFIED' });
    });
  });

  it('audits manual-to-automatic switching and advances the unchanged subject into publishing', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-switch-manual-automatic')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'switch-manual-automatic');
      await board.resolveGate({ ...boundDecision(opened.gate, opened.subject), decision: 'approve_manual' } as never);
      const switched = await board.updateApprovalDelivery({ gateId: opened.gate.id, actor: DECIDER, mode: 'automatic' });
      expect(switched).toMatchObject({ ok: true, value: { currentStageKey: 'publish', state: 'submitted' } });
      expect(state.storage.sql.exec('SELECT decision FROM gates WHERE id = ?', opened.gate.id).one()).toEqual({
        decision: 'approve_automatic',
      });
      expect(state.storage.sql.exec('SELECT event, from_mode, to_mode, actor FROM approval_delivery_events').toArray()).toEqual([
        { event: 'approved', from_mode: null, to_mode: 'manual', actor: DECIDER },
        { event: 'mode_switched', from_mode: 'manual', to_mode: 'automatic', actor: DECIDER },
      ]);
    });
  });

  it('allows automatic-to-manual switching only before a publisher claim', async () => {
    for (const claimed of [false, true]) {
      const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`approval-switch-automatic-manual-${claimed}`)) as unknown as DurableObjectStub<BoardDO>;
      await runInDurableObject(stub, async (board: BoardDO, state) => {
        const opened = await openBoundGate(board, state, `switch-automatic-manual-${claimed}`);
        await board.resolveGate({ ...boundDecision(opened.gate, opened.subject), decision: 'approve_automatic' } as never);
        if (claimed) {
          const claim = await board.claim({ agentId: PUBLISHER, capabilities: ['x-publish'] });
          if (!claim.claimed) throw new Error('publisher fixture was not claimable');
        }
        const switched = await board.updateApprovalDelivery({ gateId: opened.gate.id, actor: DECIDER, mode: 'manual' });
        if (claimed) {
          expect(switched).toMatchObject({ ok: false, code: 'APPROVAL_DELIVERY_STARTED' });
        } else {
          expect(switched).toMatchObject({ ok: true, value: { currentStageKey: 'approve', state: 'input-required' } });
          expect(state.storage.sql.exec('SELECT decision FROM gates WHERE id = ?', opened.gate.id).one()).toEqual({
            decision: 'approve_manual',
          });
        }
      });
    }
  });

  it('records a manual live URL with actor/time audit and an explicit unverified read-back status', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-manual-live-url')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'manual-live-url');
      await board.resolveGate({ ...boundDecision(opened.gate, opened.subject), decision: 'approve_manual' } as never);
      const recorded = await board.updateApprovalDelivery({
        gateId: opened.gate.id,
        actor: DECIDER,
        liveUrl: 'https://x.example.invalid/fixture/status/1',
      });
      expect(recorded).toMatchObject({
        ok: true,
        value: { delivery: { mode: 'manual', liveUrl: 'https://x.example.invalid/fixture/status/1', readBackStatus: 'not_checked' } },
      });
      expect(
        state.storage.sql
          .exec('SELECT event, actor, live_url FROM approval_delivery_events WHERE event = ?', 'live_url_recorded')
          .one(),
      ).toEqual({ event: 'live_url_recorded', actor: DECIDER, live_url: 'https://x.example.invalid/fixture/status/1' });
    });
  });

  it('serves the audited delivery workflow through the signed-in human route', async () => {
    const tenantId = 'tnt_delivery_route';
    const boardId = 'brd_delivery_route';
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`${tenantId}:${boardId}`)) as unknown as DurableObjectStub<BoardDO>;
    let gateId = '';
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'delivery-route', { tenantId, boardId });
      gateId = opened.gate.id;
      await board.resolveGate({ ...boundDecision(opened.gate, opened.subject), decision: 'approve_manual' } as never);
    });

    const response = await SELF.fetch(`https://api.test/v1/boards/${boardId}/gates/${gateId}/delivery`, {
      method: 'POST',
      headers: auth(tenantId, { 'X-User-Id': DECIDER }),
      body: JSON.stringify({ mode: 'automatic' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      card: { currentStageKey: 'publish', state: 'submitted' },
      delivery: { mode: 'automatic', liveUrl: null },
    });
  });

  it.each(['request_changes', 'reject'] as const)(
    '%s retires the bound subject and clears the active pointer',
    async (decision) => {
      const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`approval-negative-${decision}`)) as unknown as DurableObjectStub<BoardDO>;
      await runInDurableObject(stub, async (board: BoardDO, state) => {
        const opened = await openBoundGate(board, state, decision);
        const result = await board.resolveGate({ ...boundDecision(opened.gate, opened.subject), decision } as never);
        expect(result.ok).toBe(true);
        expect(
          state.storage.sql.exec('SELECT status, invalidation_reason FROM approval_subjects WHERE id = ?', opened.subject.id).one(),
        ).toEqual({ status: 'invalidated', invalidation_reason: `gate.${decision}` });
        expect(state.storage.sql.exec('SELECT active_approval_subject_id FROM cards WHERE id = ?', opened.cardId).one()).toEqual({
          active_approval_subject_id: null,
        });
      });
    },
  );
});

describe('authoritative rendering and invalidation', () => {
  it('returns the stored immutable subject to the gate renderer instead of mutable card handoff', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-authoritative-render')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'render');
      state.storage.sql.exec(
        `UPDATE cards SET handoff_json = ? WHERE id = ?`,
        JSON.stringify({ publicationPayload: { ...payload(), items: [{ ...payload().items[0], text: 'MUTATED CARD COPY' }] } }),
        opened.cardId,
      );

      const gate = await board.getGate(opened.gate.id);
      expect(gate).toMatchObject({
        ok: true,
        value: {
          approvalSubject: {
            id: opened.subject.id,
            digest: opened.subject.digest,
            canonical: JSON.parse(utf8(opened.subject.canonical_bytes)),
          },
        },
      });
      expect(JSON.stringify(gate)).not.toContain('MUTATED CARD COPY');
    });
  });

  it('invalidates and cancels the active subject before approval on any spec edit', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-invalidate-before')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'invalidate-before');
      const updated = await board.updateCard(opened.cardId, { spec: { editorialNote: 'changed' } });
      expect(updated.ok).toBe(true);
      expect(state.storage.sql.exec('SELECT status, invalidation_reason FROM approval_subjects WHERE id = ?', opened.subject.id).one()).toMatchObject({
        status: 'invalidated',
        invalidation_reason: 'card.spec_changed',
      });
      expect(state.storage.sql.exec('SELECT status FROM gates WHERE id = ?', opened.gate.id).one()).toEqual({ status: 'cancelled' });
      expect(state.storage.sql.exec('SELECT active_approval_subject_id FROM cards WHERE id = ?', opened.cardId).one()).toEqual({
        active_approval_subject_id: null,
      });
    });
  });

  it('invalidates the frozen subject when other card review context is edited', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-invalidate-card-edit')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'invalidate-card-edit');
      const updated = await board.updateCard(opened.cardId, { title: 'Edited after rendering' });
      expect(updated.ok).toBe(true);
      expect(state.storage.sql.exec('SELECT status, invalidation_reason FROM approval_subjects WHERE id = ?', opened.subject.id).one()).toEqual({
        status: 'invalidated',
        invalidation_reason: 'card.changed',
      });
      expect(state.storage.sql.exec('SELECT active_approval_subject_id FROM cards WHERE id = ?', opened.cardId).one()).toEqual({
        active_approval_subject_id: null,
      });
    });
  });

  it('invalidates an approved subject when the card is edited before the publisher claims it', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-invalidate-after')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'invalidate-after');
      const approved = await board.resolveGate(boundDecision(opened.gate, opened.subject) as never);
      expect(approved.ok).toBe(true);
      await board.updateCard(opened.cardId, { spec: { copyChangedAfterApproval: true } });

      expect(state.storage.sql.exec('SELECT status FROM approval_subjects WHERE id = ?', opened.subject.id).one()).toEqual({
        status: 'invalidated',
      });
      const publisherClaim = await board.claim({ agentId: PUBLISHER, capabilities: ['x-publish'] });
      expect(publisherClaim).toMatchObject({ claimed: false });
    });
  });

  it('invalidates on a human route change but keeps the immutable audit row', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-invalidate-move')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'invalidate-move');
      const moved = await board.moveCard(opened.cardId, 'draft', DECIDER);
      expect(moved.ok).toBe(true);
      expect(state.storage.sql.exec('SELECT id, status FROM approval_subjects WHERE id = ?', opened.subject.id).one()).toEqual({
        id: opened.subject.id,
        status: 'invalidated',
      });
      expect(state.storage.sql.exec('SELECT active_approval_subject_id FROM cards WHERE id = ?', opened.cardId).one()).toEqual({
        active_approval_subject_id: null,
      });
    });
  });

  it('does not invalidate approval when execution evidence is attached as a reference', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-reference-safe')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'reference-safe');
      const attached = await board.addReference({
        cardId: opened.cardId,
        url: 'https://example.invalid/result/fixture-1',
        provider: 'url',
        sourceType: 'result',
        addedBy: 'user',
      });
      expect(attached.ok).toBe(true);
      expect(state.storage.sql.exec('SELECT status FROM approval_subjects WHERE id = ?', opened.subject.id).one()).toEqual({ status: 'active' });
      expect(state.storage.sql.exec('SELECT active_approval_subject_id FROM cards WHERE id = ?', opened.cardId).one()).toEqual({
        active_approval_subject_id: opened.subject.id,
      });
    });
  });
});

describe('run-fenced approval-subject verify route', () => {
  it('authenticates the run owner and enforces lease, schema, subject, gate, account and expiry without hard-coded account ids', async () => {
    const tenantId = 'tnt_subject_verify';
    const boardId = 'brd_subject_verify';
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`${tenantId}:${boardId}`)) as unknown as DurableObjectStub<BoardDO>;
    let runId = '';
    let leaseEpoch = 0;
    let expectedSubjectId = '';
    let expectedDigest = '';
    let expectedCanonicalBase64 = '';

    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'verify', { boardId, tenantId });
      const approved = await board.resolveGate(boundDecision(opened.gate, opened.subject) as never);
      if (!approved.ok) throw new Error(approved.message);
      const claim = await board.claim({ agentId: PUBLISHER, capabilities: ['x-publish'] });
      if (!claim.claimed) throw new Error('publisher fixture was not claimable');
      runId = claim.runId;
      leaseEpoch = claim.leaseEpoch;
      expectedSubjectId = opened.subject.id;
      expectedDigest = opened.subject.digest;
      expectedCanonicalBase64 = base64(opened.subject.canonical_bytes);
    });

    const expected = {
      expectedSchema: 'social-publish/v1',
      expectedSubjectId,
      expectedDigest,
      expectedAccount: ACCOUNT,
    };
    const url = `https://api.test/v1/boards/${boardId}/runs/${runId}/approval-subject/verify`;
    const wrongOwner = await SELF.fetch(url, {
      method: 'POST',
      headers: auth(tenantId, { 'X-Agent-Id': 'agt_fixture_intruder' }),
      body: JSON.stringify({ leaseEpoch, ...expected }),
    });
    expect(wrongOwner.status).toBe(403);

    const stale = await SELF.fetch(url, {
      method: 'POST',
      headers: auth(tenantId, { 'X-Agent-Id': PUBLISHER }),
      body: JSON.stringify({ leaseEpoch: leaseEpoch + 1, ...expected }),
    });
    expect(stale.status).toBe(409);

    const wrongSchema = await SELF.fetch(url, {
      method: 'POST',
      headers: auth(tenantId, { 'X-Agent-Id': PUBLISHER }),
      body: JSON.stringify({ leaseEpoch, ...expected, expectedSchema: 'other/v1' }),
    });
    expect(wrongSchema.status).toBe(409);

    const missingExactDigest = await SELF.fetch(url, {
      method: 'POST',
      headers: auth(tenantId, { 'X-Agent-Id': PUBLISHER }),
      body: JSON.stringify({ leaseEpoch, expectedSchema: 'social-publish/v1' }),
    });
    expect(missingExactDigest.status).toBe(400);

    const verified = await SELF.fetch(url, {
      method: 'POST',
      headers: auth(tenantId, { 'X-Agent-Id': PUBLISHER }),
      body: JSON.stringify({
        leaseEpoch,
        expectedSchema: 'social-publish/v1',
        expectedSubjectId,
        expectedDigest,
        expectedAccount: ACCOUNT,
      }),
    });
    expect(verified.status).toBe(200);
    const body = await verified.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      boardId,
      projectId: 'prj_fixture',
      cardId: expect.any(String),
      runId,
      stageKey: 'publish',
      expiresAt: '2030-01-02T03:04:05Z',
      canonicalBytesBase64: expectedCanonicalBase64,
      subject: {
        id: expectedSubjectId,
        digest: expectedDigest,
        schema: 'social-publish/v1',
        account: ACCOUNT,
      },
      gate: { decision: 'approve', decidedBy: DECIDER, resolvedAt: expect.any(String) },
    });
    expect((body.subject as { canonical: { cardId: string } }).canonical.cardId).toBe(body.cardId);
  });

  it.each([
    {
      name: 'inactive subject',
      expectedStatus: 409,
      mutate: (sql: SqlStorage, subjectId: string) => sql.exec(`UPDATE approval_subjects SET status = 'invalidated' WHERE id = ?`, subjectId),
    },
    {
      name: 'inactive card pointer',
      expectedStatus: 409,
      mutate: (sql: SqlStorage, _subjectId: string, cardId: string) =>
        sql.exec(`UPDATE cards SET active_approval_subject_id = NULL WHERE id = ?`, cardId),
    },
    {
      name: 'non-approve gate decision',
      expectedStatus: 409,
      mutate: (sql: SqlStorage, _subjectId: string, _cardId: string, gateId: string) =>
        sql.exec(`UPDATE gates SET decision = 'reject' WHERE id = ?`, gateId),
    },
    {
      name: 'wrong current stage',
      expectedStatus: 409,
      mutate: (sql: SqlStorage, _subjectId: string, cardId: string) =>
        sql.exec(`UPDATE cards SET current_stage_key = 'recorded' WHERE id = ?`, cardId),
    },
  ])('refuses a $name before returning canonical bytes', async ({ name, expectedStatus, mutate }) => {
    const tenantId = `tnt_verify_${name}`;
    const boardId = `brd_verify_${name}`;
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`${tenantId}:${boardId}`)) as unknown as DurableObjectStub<BoardDO>;
    let runId = '';
    let leaseEpoch = 0;
    let expectedSubjectId = '';
    let expectedDigest = '';

    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, `verify-${name}`, { boardId, tenantId });
      const approved = await board.resolveGate(boundDecision(opened.gate, opened.subject) as never);
      if (!approved.ok) throw new Error(approved.message);
      const claim = await board.claim({ agentId: PUBLISHER, capabilities: ['x-publish'] });
      if (!claim.claimed) throw new Error('publisher fixture was not claimable');
      runId = claim.runId;
      leaseEpoch = claim.leaseEpoch;
      expectedSubjectId = opened.subject.id;
      expectedDigest = opened.subject.digest;
      mutate(state.storage.sql, opened.subject.id, opened.cardId, opened.gate.id);
    });

    const response = await SELF.fetch(`https://api.test/v1/boards/${boardId}/runs/${runId}/approval-subject/verify`, {
      method: 'POST',
      headers: auth(tenantId, { 'X-Agent-Id': PUBLISHER }),
      body: JSON.stringify({
        leaseEpoch,
        expectedSchema: 'social-publish/v1',
        expectedSubjectId,
        expectedDigest,
        expectedAccount: ACCOUNT,
      }),
    });
    expect(response.status).toBe(expectedStatus);
  });

  it.each([
    {
      name: 'card-to-subject project join',
      mutate: (sql: SqlStorage) => sql.exec(`UPDATE cards SET project_id = 'prj_other'`),
    },
    {
      name: 'configured x-publish stage',
      mutate: (sql: SqlStorage) => {
        const stages = STAGES.map((stage) => (stage.key === 'publish' ? { ...stage, owner: 'other-capability' } : stage));
        sql.exec(`UPDATE meta SET v = ? WHERE k = 'stages'`, JSON.stringify(stages));
      },
    },
  ])('refuses a broken $name', async ({ name, mutate }) => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`approval-verify-join-${name}`)) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, name);
      const approved = await board.resolveGate(boundDecision(opened.gate, opened.subject) as never);
      if (!approved.ok) throw new Error(approved.message);
      const claim = await board.claim({ agentId: PUBLISHER, capabilities: ['x-publish'] });
      if (!claim.claimed) throw new Error('publisher fixture was not claimable');
      mutate(state.storage.sql);
      const verified = await board.verifyApprovalSubject({
        runId: claim.runId,
        leaseEpoch: claim.leaseEpoch,
        agentId: PUBLISHER,
        expectedSchema: 'social-publish/v1',
        expectedSubjectId: opened.subject.id,
        expectedDigest: opened.subject.digest,
        expectedAccount: ACCOUNT,
      });
      expect(verified).toMatchObject({ ok: false, code: 'APPROVAL_SUBJECT_NOT_VERIFIED' });
    });
  });

  it('returns 410 for an expired otherwise-valid subject', async () => {
    const tenantId = 'tnt_verify_expired';
    const boardId = 'brd_verify_expired';
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName(`${tenantId}:${boardId}`)) as unknown as DurableObjectStub<BoardDO>;
    let runId = '';
    let leaseEpoch = 0;
    let expectedSubjectId = '';
    let expectedDigest = '';

    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'verify-expired', {
        boardId,
        tenantId,
        publicationPayload: payload('2020-01-02T03:04:05Z'),
      });
      const approved = await board.resolveGate(boundDecision(opened.gate, opened.subject) as never);
      if (!approved.ok) throw new Error(approved.message);
      const claim = await board.claim({ agentId: PUBLISHER, capabilities: ['x-publish'] });
      if (!claim.claimed) throw new Error('publisher fixture was not claimable');
      runId = claim.runId;
      leaseEpoch = claim.leaseEpoch;
      expectedSubjectId = opened.subject.id;
      expectedDigest = opened.subject.digest;
    });

    const response = await SELF.fetch(`https://api.test/v1/boards/${boardId}/runs/${runId}/approval-subject/verify`, {
      method: 'POST',
      headers: auth(tenantId, { 'X-Agent-Id': PUBLISHER }),
      body: JSON.stringify({
        leaseEpoch,
        expectedSchema: 'social-publish/v1',
        expectedSubjectId,
        expectedDigest,
        expectedAccount: ACCOUNT,
      }),
    });
    expect(response.status).toBe(410);
  });
});

describe('bound gate notification', () => {
  it('carries immutable subject metadata and a private review route, never mutable handoff text', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-bound-notification')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      const opened = await openBoundGate(board, state, 'notification');
      const [pending] = await board.pendingGateDeliveries();
      expect(pending).toMatchObject({
        cardId: opened.cardId,
        gateId: opened.gate.id,
        handoffSummary: null,
        reviewUrl: `/b/brd_fixture_notification/c/${opened.cardId}`,
        approvalSubject: {
          id: opened.subject.id,
          digest: opened.subject.digest,
          schema: 'social-publish/v1',
          revision: 1,
        },
      });
      expect(JSON.stringify(pending)).not.toContain('Exact fixture text');
    });
  });
});

describe('generic gates remain backward-compatible', () => {
  it('opens and resolves an ordinary gate without creating or requiring an approval subject', async () => {
    const generic = STAGES.map((stage) => {
      if (stage.key !== 'approve') return stage;
      const { approvalSubjectSchema: _schema, approvalDeciderPrincipalIds: _deciders, ...plain } = stage;
      return plain;
    }) as BoardInit['stages'];
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-generic-regression')) as unknown as DurableObjectStub<BoardDO>;
    await runInDurableObject(stub, async (board: BoardDO, state) => {
      await board.init({ id: 'brd_generic', tenantId: 'tnt_fixture', name: 'Generic gate fixture', stages: generic });
      const made = await board.createCard({ title: 'Generic fixture', ownerUserId: 'usr_fixture_owner' });
      if (!made.ok) throw new Error(made.message);
      const claim = await board.claim({ agentId: PRODUCER, capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('generic draft was not claimable');
      const completed = await board.complete({ runId: claim.runId, leaseEpoch: claim.leaseEpoch, handoff: { summary: 'generic' } });
      expect(completed.ok).toBe(true);
      expect(state.storage.sql.exec('SELECT id FROM approval_subjects').toArray()).toHaveLength(0);
      const gate = state.storage.sql.exec('SELECT id, approval_subject_id, approval_subject_digest FROM gates').one() as {
        id: string;
        approval_subject_id: null;
        approval_subject_digest: null;
      };
      expect(gate).toMatchObject({ approval_subject_id: null, approval_subject_digest: null });
      const resolved = await board.resolveGate({ gateId: gate.id, decision: 'approve', decidedBy: OTHER_HUMAN });
      expect(resolved).toMatchObject({ ok: true, value: { currentStageKey: 'publish' } });
    });
  });
});
