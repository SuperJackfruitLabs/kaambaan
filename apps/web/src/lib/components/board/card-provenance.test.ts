import { describe, it, expect } from 'vitest';
import { cardProvenance } from './card-provenance';

/**
 * Who asked for this card.
 *
 * A card has THREE identities — owner, queued-by, delegate — and the board rendered two of them.
 * `queuedBy` was carried on every card, deliberately preserved when ownership is reassigned, and
 * then shown nowhere a person could see it. That was survivable while every card was queued by the
 * same human. It stops being survivable the moment an agent can queue work, because then "Super
 * Chotu asked for this" and "the operator asked for this" are different facts and the audit trail
 * silently credits the operator with work they never requested.
 */
const MEMBERS = [{ userId: 'usr_rakesh', email: 'r@example.test', name: 'Rakesh', role: 'owner' }];
const AGENTS = [
  { id: 'agt_chotu', name: 'Super Chotu', capabilities: ['command'], externalId: 'prn_chotu0000000000q1', iconUrl: null },
  { id: 'agt_kai', name: 'Coder Kai', capabilities: ['code'], externalId: 'prn_kai', iconUrl: null },
  { id: 'agt_tim', name: 'Tester Tim', capabilities: ['test'], externalId: 'prn_tim', iconUrl: null },
];

const card = (over: Record<string, unknown> = {}) =>
  ({
    id: 'card_1',
    title: 'T',
    ownerUserId: 'usr_rakesh',
    queuedBy: 'usr_rakesh',
    queuedByAgentId: null,
    queuedGrant: null,
    delegateAgentId: null,
    ...over,
  }) as never;

describe('a human-queued card', () => {
  it('names the person and is NOT marked as an agent\'s', () => {
    const p = cardProvenance(card(), MEMBERS as never, AGENTS as never);
    expect(p.queuedByName).toBe('Rakesh');
    expect(p.byAgent).toBe(false);
    expect(p.agent).toBeNull();
  });

  it('says nothing at all when the card predates the field', () => {
    // Every card created before `queued_by` existed carries null. A row reading "queued by —"
    // would be noise on a board full of them; absent is the honest render.
    const p = cardProvenance(card({ queuedBy: null }), MEMBERS as never, AGENTS as never);
    expect(p.known).toBe(false);
    expect(p.queuedByName).toBe('');
  });
});

describe('an agent-queued card', () => {
  const agentCard = card({
    queuedBy: 'prn_chotu0000000000q1',
    queuedByAgentId: 'agt_chotu',
    queuedGrant: ['prn_kai', 'prn_tim'],
  });

  it('reads as a NAME, never an id (U2)', () => {
    const p = cardProvenance(agentCard, MEMBERS as never, AGENTS as never);
    expect(p.queuedByName).toBe('Super Chotu');
    expect(p.queuedByName).not.toContain('prn_');
  });

  it('is distinguishable from a human-queued card without reading anything (U3)', () => {
    // The whole audit requirement. If the operator cannot see which cards they did not ask for,
    // the provenance field is decoration.
    expect(cardProvenance(agentCard, MEMBERS as never, AGENTS as never).byAgent).toBe(true);
    expect(cardProvenance(card(), MEMBERS as never, AGENTS as never).byAgent).toBe(false);
  });

  it('carries the agent row, so a tile can show its avatar and colour (U4)', () => {
    const p = cardProvenance(agentCard, MEMBERS as never, AGENTS as never);
    expect(p.agent?.id).toBe('agt_chotu');
  });

  it('is STILL agent-queued when the agent row is gone', () => {
    // A deleted or renamed agent must not turn an agent-queued card back into a human-queued one.
    // This is why the card stores `queuedByAgentId` rather than deriving it from a join.
    const p = cardProvenance(agentCard, MEMBERS as never, [] as never);
    expect(p.byAgent).toBe(true);
    expect(p.agent).toBeNull();
    // And it falls back to the short id rather than to a blank or to the operator's name.
    expect(p.queuedByName).toBe('prn_…0000q1');
  });
});

describe('the grant is inspectable, not just stored (U7)', () => {
  it('counts the principals, because a 55-principal grant and a 3-principal grant differ', () => {
    const p = cardProvenance(
      card({ queuedBy: 'prn_chotu0000000000q1', queuedByAgentId: 'agt_chotu', queuedGrant: ['prn_kai', 'prn_tim'] }),
      MEMBERS as never,
      AGENTS as never,
    );
    expect(p.grantSize).toBe(2);
  });

  it('distinguishes a grant nobody recorded from one that names nobody', () => {
    // Exactly the distinction the API draws: null is "no authority was captured", `[]` is
    // "somebody decided no". Both refuse a claim; they are different facts about why.
    expect(cardProvenance(card({ queuedGrant: null }), MEMBERS as never, AGENTS as never).grantSize).toBeNull();
    expect(cardProvenance(card({ queuedGrant: [] }), MEMBERS as never, AGENTS as never).grantSize).toBe(0);
  });

  it('answers whether the queuer could dispatch the agent actually working it', () => {
    const covered = cardProvenance(
      card({ queuedGrant: ['prn_kai'], delegateAgentId: 'agt_kai' }),
      MEMBERS as never,
      AGENTS as never,
    );
    expect(covered.grantCoversDelegate).toBe(true);

    // The interesting case: a card being worked by an agent its queuer was never permitted to
    // dispatch. Under enforcement that should be impossible, so seeing it means enforcement is off
    // or the grant was narrowed after the claim — both worth being able to notice.
    const uncovered = cardProvenance(
      card({ queuedGrant: ['prn_tim'], delegateAgentId: 'agt_kai' }),
      MEMBERS as never,
      AGENTS as never,
    );
    expect(uncovered.grantCoversDelegate).toBe(false);
  });

  it('answers null — not false — when nothing is working the card yet', () => {
    // "No agent holds it" is not "the grant does not cover the agent". A false here would render as
    // a warning about a card that has done nothing wrong.
    const p = cardProvenance(card({ queuedGrant: ['prn_kai'] }), MEMBERS as never, AGENTS as never);
    expect(p.grantCoversDelegate).toBeNull();
  });

  it('answers null when the delegate was never mapped to a principal', () => {
    // An unmapped agent cannot be named by any grant, so no grant can be said to cover it. The
    // claim-side rule is identical: "no grant, however it reads, can cover an id that does not
    // exist yet."
    const unmapped = [{ id: 'agt_local', name: 'Local only', capabilities: [], externalId: null, iconUrl: null }];
    const p = cardProvenance(
      card({ queuedGrant: ['prn_kai'], delegateAgentId: 'agt_local' }),
      MEMBERS as never,
      unmapped as never,
    );
    expect(p.grantCoversDelegate).toBeNull();
  });
});
