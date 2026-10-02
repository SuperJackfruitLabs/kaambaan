import { describe, expect, it } from 'vitest';
import { stageOwner } from './stage-owner';

/**
 * Who works a lane.
 *
 * A board showed seven stage names and nothing about who any of them were for. The routing rule is
 * exact string equality between a stage's capability and an agent's, so "which agent picks this up"
 * was a question you answered by opening another screen and comparing two lists by eye — and the
 * commonest cause of a card that never moves is a lane whose capability nobody holds, which looked
 * exactly like a lane nobody had got to yet.
 */
const AGENTS = [
  { id: 'agt_ulrich', name: 'ux-ulrich', capabilities: ['ux'] },
  { id: 'agt_pete', name: 'perf-pete', capabilities: ['performance'] },
  { id: 'agt_kai', name: 'coder-kai', capabilities: ['code', 'ux'] },
] as never;

describe('stageOwner', () => {
  it('names the AGENT when a stage is owned by one', () => {
    const got = stageOwner({ key: 'k', name: 'K', order: 0, ownerKind: 'agent', owner: 'agt_kai' } as never, AGENTS);
    expect(got.kind).toBe('agent');
    expect(got.label).toBe('coder-kai');
  });

  it('falls back to a short id for an agent the workspace cannot name', () => {
    // The agents list can lag the board, and a stage can name an agent since deleted. A blank where
    // the owner goes is worse than the id.
    const got = stageOwner({ key: 'k', name: 'K', order: 0, ownerKind: 'agent', owner: 'agt_gone00000000' } as never, AGENTS);
    expect(got.label).toContain('agt_');
  });

  it('names the CAPABILITY, and counts who declares it', () => {
    const got = stageOwner({ key: 'k', name: 'K', order: 0, ownerKind: 'capability', owner: 'ux' } as never, AGENTS);
    expect(got.kind).toBe('capability');
    expect(got.label).toBe('ux');
    expect(got.declaredBy).toEqual(['ux-ulrich', 'coder-kai']);
  });

  it('FLAGS a capability nobody declares — the commonest cause of a stalled card', () => {
    // A card in such a lane sits in `submitted` forever and looks queued. This is the one state the
    // header exists to surface.
    const got = stageOwner({ key: 'k', name: 'K', order: 0, ownerKind: 'capability', owner: 'monitoring' } as never, AGENTS);
    expect(got.declaredBy).toEqual([]);
    expect(got.undeclared).toBe(true);
  });

  it('says DECLARED, never "can claim" — implications are resolved server-side', () => {
    // The board does not load the implication graph, so an agent holding `code` may effectively hold
    // `review` and this cannot know. Claiming "nobody can claim this" would be an assertion the
    // client cannot support; counting declarations is one it can.
    const got = stageOwner({ key: 'k', name: 'K', order: 0, ownerKind: 'capability', owner: 'review' } as never, AGENTS);
    expect(got.undeclared).toBe(true);
    expect(got.caveat).toMatch(/implicat/i);
  });

  it('reads a multi-capability requirement, both shapes', () => {
    const all = stageOwner(
      { key: 'k', name: 'K', order: 0, ownerKind: 'capability', requires: { all: ['ux', 'performance'] } } as never,
      AGENTS,
    );
    expect(all.label).toBe('ux + performance');
    const any = stageOwner(
      { key: 'k', name: 'K', order: 0, ownerKind: 'capability', requires: { any: ['ux', 'code'] } } as never,
      AGENTS,
    );
    expect(any.label).toBe('ux or code');
  });

  it('for `all`, counts only agents declaring EVERY capability', () => {
    // `any` and `all` are different questions and a count that conflated them would overstate who
    // can work the lane.
    const got = stageOwner(
      { key: 'k', name: 'K', order: 0, ownerKind: 'capability', requires: { all: ['code', 'ux'] } } as never,
      AGENTS,
    );
    expect(got.declaredBy).toEqual(['coder-kai']);
  });

  it('says a HUMAN stage is a person, and a gated one is a review', () => {
    const plain = stageOwner({ key: 'k', name: 'K', order: 0, ownerKind: 'human' } as never, AGENTS);
    expect(plain.kind).toBe('human');
    expect(plain.label).toBe('a person');
    const gated = stageOwner({ key: 'k', name: 'K', order: 0, ownerKind: 'human', gate: 'approval' } as never, AGENTS);
    expect(gated.label).toBe('a person · approval');
  });

  it('never returns an empty label, whatever the stage carries', () => {
    // A header that renders nothing is the state this replaces. A capability stage with no owner at
    // all is malformed, and saying so beats a blank line.
    const got = stageOwner({ key: 'k', name: 'K', order: 0, ownerKind: 'capability' } as never, AGENTS);
    expect(got.label.length).toBeGreaterThan(0);
  });
});
