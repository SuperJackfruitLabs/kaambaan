import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

/**
 * Regression caught here: `complete()` currently treats an opt-in social approval stage like a
 * generic gate, leaving the mutable handoff as the only copy and binding neither the gate nor card
 * to immutable canonical bytes. A production change that drops/ignores `approvalSubjectSchema`,
 * subject insertion, or either foreign-key binding must make this test fail.
 */
const STAGES = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
  {
    key: 'approve',
    name: 'Approve',
    order: 1,
    ownerKind: 'human',
    gate: 'approval',
    approvalSubjectSchema: 'social-publish/v1',
    approvalDeciderPrincipalIds: ['usr_fixture_reviewer'],
  },
] as unknown as BoardInit['stages'];

const PUBLICATION_PAYLOAD = {
  channel: 'x',
  account: { platform: 'x', userId: 'acct_fixture_1', username: 'example_product' },
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
  timing: { mode: 'immediate', notBefore: null, expiresAt: '2030-01-02T03:04:05Z' },
  evidenceRefs: ['https://example.invalid/evidence/fixture-1'],
  policy: {
    allowThread: true,
    duplicatePolicyId: 'fixture-duplicate-policy',
    floodPolicyId: 'fixture-flood-policy',
  },
};

function expectedCanonicalBytes(cardId: string): string {
  // Deliberately literal: this fixture independently pins RFC 8785 key ordering and exact values.
  return (
    '{"account":{"platform":"x","userId":"acct_fixture_1","username":"example_product"},' +
    `"cardId":${JSON.stringify(cardId)},` +
    '"channel":"x","evidenceRefs":["https://example.invalid/evidence/fixture-1"],' +
    '"items":[{"index":0,"media":[{"altText":"A generic fixture image","mime":"image/png",' +
    '"objectRef":"immutable://fixture/media-1","rightsRef":"evidence://fixture/rights-1",' +
    '"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":12345}],' +
    '"quotePostId":null,"replyToPostId":null,' +
    '"text":"Exact fixture text — spacing and Unicode stay unchanged.\\nSecond line."}],' +
    '"policy":{"allowThread":true,"duplicatePolicyId":"fixture-duplicate-policy",' +
    '"floodPolicyId":"fixture-flood-policy"},"projectId":"prj_fixture","revision":1,' +
    '"schema":"social-publish/v1","timing":{"expiresAt":"2030-01-02T03:04:05Z",' +
    '"mode":"immediate","notBefore":null}}'
  );
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function utf8(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  throw new TypeError(`canonical_bytes was not a BLOB: ${Object.prototype.toString.call(value)}`);
}

describe('immutable approval subjects', () => {
  it('atomically snapshots and binds an RFC 8785 subject when a run enters an opt-in gate', async () => {
    const stub = env.BOARD_DO.get(env.BOARD_DO.idFromName('approval-subject-bind-1')) as unknown as DurableObjectStub<BoardDO>;

    await runInDurableObject(stub, async (board: BoardDO, state) => {
      await board.init({ id: 'brd_fixture', tenantId: 'tnt_fixture', name: 'Fixture board', stages: STAGES });
      const created = await board.createCard({
        title: 'Sanitized publication fixture',
        ownerUserId: 'usr_fixture_owner',
        projectId: 'prj_fixture',
      });
      if (!created.ok) throw new Error(created.message);

      const claim = await board.claim({ agentId: 'agt_fixture_writer', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('fixture draft was not claimable');

      const completed = await board.complete({
        runId: claim.runId,
        leaseEpoch: claim.leaseEpoch,
        handoff: { publicationPayload: PUBLICATION_PAYLOAD },
      });
      expect(completed.ok).toBe(true);

      const sql = state.storage.sql;
      // This is the red assertion on the pre-fix implementation: it opens only a generic gate.
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approval_subjects'`).toArray()).toHaveLength(1);

      const subjects = sql
        .exec(
          `SELECT id, card_id, gate_stage_key, schema, revision, canonical_bytes, digest, status,
                  producer_run_id, produced_by
             FROM approval_subjects`,
        )
        .toArray();
      expect(subjects).toHaveLength(1);
      const subject = subjects[0]!;
      const canonicalBytes = expectedCanonicalBytes(created.value.id);
      const digest = await sha256(canonicalBytes);
      expect(subject).toMatchObject({
        card_id: created.value.id,
        gate_stage_key: 'approve',
        schema: 'social-publish/v1',
        revision: 1,
        digest,
        status: 'active',
        producer_run_id: claim.runId,
        produced_by: 'agt_fixture_writer',
      });
      expect(subject.id).toMatch(/^aps_[a-zA-Z0-9]+$/);
      expect(utf8(subject.canonical_bytes)).toBe(canonicalBytes);

      expect(
        sql
          .exec(
            `SELECT approval_subject_id, approval_subject_digest, approval_decider_ids_json
               FROM gates WHERE card_id = ? AND stage_key = 'approve'`,
            created.value.id,
          )
          .one(),
      ).toEqual({
        approval_subject_id: subject.id,
        approval_subject_digest: digest,
        approval_decider_ids_json: JSON.stringify(['usr_fixture_reviewer']),
      });
      expect(sql.exec(`SELECT active_approval_subject_id FROM cards WHERE id = ?`, created.value.id).one()).toEqual({
        active_approval_subject_id: subject.id,
      });
    });
  });
});
