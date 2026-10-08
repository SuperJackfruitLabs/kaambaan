/**
 * What the Needs-you panel says about each card, and what it offers to do about it.
 *
 * The panel used to read only "is there a gate / a question / a failure", and called every other
 * `input-required` card "not dispatched — nobody with permission asked for it", with a link to
 * staff an agent. That was wrong for a card its own agent blocked, one the breaker stopped, and one
 * refused twice at its completion check — the card said why, and the panel did not read it.
 */
import { describe, it, expect } from 'vitest';
import { itemsFromBoard, itemsFromStale } from './attention';
import type { BoardSnapshot, Card, Gate, Elicitation, StaleCard } from '$lib/api';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

function card(over: Partial<Card>): Card {
  return {
    id: 'crd_1', title: 'Add login', ownerUserId: 'usr_a', currentStageKey: 'build', state: 'submitted', priority: 0,
    costUsd: 0, overBudget: false, attemptCount: 0, queuedBy: null, queuedByAgentId: null, queuedGrant: null, labels: [],
    dueAt: null, archivedAt: null, parentCardId: null, openChildCount: 0, costUsdRollup: 0, blockedBy: [], projectId: null,
    milestoneId: null, stateSince: hoursAgo(1), ...over,
  };
}

function board(cards: Card[], extra: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    boardId: 'brd_1', tenantId: 't', name: 'Releases',
    stages: [
      { key: 'requested', name: 'Requested', order: 0, ownerKind: 'human' },
      { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'build' },
      { key: 'review', name: 'Review', order: 2, ownerKind: 'human', gate: 'approval' },
      { key: 'done', name: 'Done', order: 3, ownerKind: 'human' },
    ],
    cards, gates: [], elicitations: [], references: [],
    usage: { totalCostUsd: 0, estimatedCostUsd: 0, budgetUsd: null, cardUsdCap: null, overBudget: false },
    github: { issueTrigger: false, webhookConfigured: false, triggerGrantCount: null },
    stale: { enabled: true, afterHours: 24 },
    ...extra,
  } as BoardSnapshot;
}

const one = (b: BoardSnapshot) => {
  const items = itemsFromBoard(b, [], NOW);
  expect(items).toHaveLength(1);
  return items[0]!;
};

describe('itemsFromBoard — one row per reason, each saying what to do', () => {
  it("blocked: the agent's own words, and Resume", () => {
    const it = one(board([card({ state: 'input-required', needsHuman: { reason: 'blocked', detail: 'the staging database is down' } })]));
    expect(it.kind).toBe('blocked');
    expect(it.detail).toBe('the staging database is down');
    expect(it.instruction).toMatch(/resume/i);
    expect(it.actions).toEqual(['resume', 'open']);
  });

  it('repeated-failure: the count and the last reason, with Resume and Open log', () => {
    const it = one(board([card({ state: 'input-required', needsHuman: { reason: 'repeated-failure', failureCount: 2, detail: 'out of memory' } })]));
    expect(it.kind).toBe('repeated-failure');
    expect(it.headline).toContain('2');
    expect(it.detail).toBe('out of memory');
    expect(it.actions).toEqual(['resume', 'log']);
  });

  it('a completion-check park reads as blocked, with both refusals in the detail', () => {
    const detail = 'this stage was not finished twice — first: the handoff is missing commit; then, after one automatic rework: the handoff is missing commit';
    const it = one(board([card({ state: 'input-required', needsHuman: { reason: 'blocked', detail } })]));
    expect(it.kind).toBe('blocked');
    expect(it.detail).toBe(detail);
    expect(it.actions).not.toContain('staff');
  });

  it("not-authorised keeps today's refused wording and Staff an agent", () => {
    const it = one(board([card({ state: 'input-required', needsHuman: { reason: 'not-authorised', detail: 'queued without an authorising token' } })]));
    expect(it.kind).toBe('refused');
    expect(it.headline).toContain('not dispatched');
    expect(it.actions).toEqual(['staff']);
  });

  it('question: Answer, with the question as the detail', () => {
    const ask: Elicitation = { id: 'elc_1', cardId: 'crd_1', runId: 'run_1', stageKey: 'build', agentId: 'agt_b', question: 'Which provider?', signal: null, options: [], status: 'pending', answer: null, createdAt: hoursAgo(1) };
    const it = one(board([card({ state: 'input-required', needsHuman: { reason: 'question', elicitationId: 'elc_1' } })], { elicitations: [ask] }));
    expect(it.kind).toBe('question');
    expect(it.detail).toBe('Which provider?');
    expect(it.actions).toEqual(['answer']);
  });

  it('review: says what is being approved, and offers Review — never an approve from the list', () => {
    const gate: Gate = { id: 'gate_1', cardId: 'crd_1', stageKey: 'review', status: 'pending', options: [], producedBy: 'agt_b', summary: 'Adds the login form and its tests' };
    const it = one(board([card({ currentStageKey: 'review', state: 'input-required' })], { gates: [gate] }));
    expect(it.kind).toBe('review');
    expect(it.detail).toBe('Adds the login form and its tests');
    expect(it.actions).toEqual(['review']);
    expect(it.actions).not.toContain('approve' as never);
  });

  it('failed and over budget as before', () => {
    expect(one(board([card({ state: 'failed' })])).kind).toBe('failed');
    expect(one(board([card({ overBudget: true })])).kind).toBe('budget');
  });

  it('a card sitting in a stage nothing claims, past the threshold: "Nothing claims stage", with Move', () => {
    const it = one(board([card({ currentStageKey: 'requested', stateSince: hoursAgo(30) })]));
    expect(it.kind).toBe('no-owner');
    expect(it.headline).toBe('Nothing claims stage requested');
    expect(it.actions).toEqual(['move', 'open']);
  });

  it('…but not before the threshold, not when the board switched it off, and never for a claimable stage', () => {
    expect(itemsFromBoard(board([card({ currentStageKey: 'requested', stateSince: hoursAgo(2) })]), [], NOW)).toEqual([]);
    expect(itemsFromBoard(board([card({ currentStageKey: 'requested', stateSince: hoursAgo(30) })], { stale: { enabled: false, afterHours: 24 } }), [], NOW)).toEqual([]);
    expect(itemsFromBoard(board([card({ currentStageKey: 'build', stateSince: hoursAgo(300) })]), [], NOW)).toEqual([]);
  });

  it('leaves archived cards and healthy ones out', () => {
    expect(itemsFromBoard(board([card({ archivedAt: hoursAgo(1), state: 'failed' }), card({ id: 'crd_2' })]), [], NOW)).toEqual([]);
  });
});

describe('itemsFromStale — the workspace list uses the same rows', () => {
  const stale = (over: Partial<StaleCard>): StaleCard => ({
    boardId: 'brd_9', boardName: 'Ops', cardId: 'crd_9', title: 'Rotate keys', ownerUserId: 'usr_a', stageKey: 'build',
    stageName: 'Build', state: 'input-required', why: { kind: 'needs-human', reason: 'blocked', detail: 'vault sealed' },
    summary: null, since: hoursAgo(5), ageHours: 5, next: 'resume it', ...over,
  });

  it('maps each reason to the same kind and actions as the board panel', () => {
    const [blocked, refused, review, ownerless] = itemsFromStale([
      stale({}),
      stale({ cardId: 'a', why: { kind: 'needs-human', reason: 'not-authorised' } }),
      stale({ cardId: 'b', why: { kind: 'needs-human', reason: 'review', gateId: 'gate_1' }, summary: 'the release notes' }),
      stale({ cardId: 'c', state: 'submitted', stageKey: 'requested', why: { kind: 'no-owner' } }),
    ]);
    expect(blocked).toMatchObject({ kind: 'blocked', detail: 'vault sealed', boardId: 'brd_9', boardName: 'Ops', actions: ['resume', 'open'] });
    expect(refused).toMatchObject({ kind: 'refused', actions: ['staff'] });
    expect(review).toMatchObject({ kind: 'review', detail: 'the release notes', actions: ['review'] });
    expect(ownerless).toMatchObject({ kind: 'no-owner', headline: 'Nothing claims stage requested' });
  });
});
