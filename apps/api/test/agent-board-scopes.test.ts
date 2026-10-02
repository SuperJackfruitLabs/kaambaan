import { describe, expect, it } from 'vitest';
import { requiredScope, scopePermits } from '../src/auth/scopes';

/**
 * Which board routes an agent credential may reach, and on which scope.
 *
 * A coordinator agent now reaches board reads and card creation. Everything that follows is about
 * making sure that widening did not also widen the fleet: thirty-odd `['claim','run']` tokens
 * exist and must gain exactly nothing from these new names.
 */
describe('requiredScope names the scope a board route needs', () => {
  it('still gates the worker routes it always did', () => {
    expect(requiredScope('claims', 'POST')).toBe('claim');
    expect(requiredScope('runs/run_1/complete', 'POST')).toBe('run');
  });

  it('gates board and card reads on `read`', () => {
    expect(requiredScope('', 'GET')).toBe('read');
    expect(requiredScope('cards/card_1', 'GET')).toBe('read');
  });

  it('gates card creation on `queue`, which is a different scope from reading', () => {
    // `cards` (create) and `cards/:id` (read one) differ by one path segment and by the whole
    // question of whether an agent may spend the guild's time.
    expect(requiredScope('cards', 'POST')).toBe('queue');
    expect(requiredScope('cards', 'POST')).not.toBe(requiredScope('cards/card_1', 'GET'));
  });

  it('THE METHOD IS PART OF THE GATE: `read` is not a licence to edit or delete', () => {
    // The first cut of this took only the path, so `read` would have authorised PATCH and DELETE
    // on the very same route it was meant to let an agent LOOK at. A scope that permits more than
    // its name is how a read-only credential quietly becomes a write one.
    for (const method of ['PATCH', 'DELETE', 'PUT']) {
      expect(requiredScope('', method)).toBe('__forbidden__');
      expect(requiredScope('cards/card_1', method)).toBe('__forbidden__');
    }
  });

  it('leaves the ungated agent routes ungated', () => {
    // `gates/pending` names nobody and carries no authority — the hub's reconciliation read.
    expect(requiredScope('gates/pending', 'GET')).toBeNull();
    expect(requiredScope('gates/gate_1', 'GET')).toBeNull();
  });
});

describe('the grandfather clause does not reach the new scopes', () => {
  // THE regression. `scopePermits` has always let `claim` imply `run`, and its entire argument is
  // about FINISHING work already claimed: "a claim an agent cannot complete is not a safer claim".
  // Reading every board in the workspace and creating work are not finishing anything. If this
  // ever passes, every worker token in the fleet silently became a coordinator's.
  const legacy = ['claim'];
  const current = ['claim', 'run'];

  it('a legacy claim-only token cannot read', () => {
    expect(scopePermits(legacy, 'read')).toBe(false);
    expect(scopePermits(current, 'read')).toBe(false);
  });

  it('a worker token cannot queue', () => {
    expect(scopePermits(legacy, 'queue')).toBe(false);
    expect(scopePermits(current, 'queue')).toBe(false);
  });

  it('`read` does not imply `queue` — observing is not co-signing', () => {
    expect(scopePermits(['read'], 'queue')).toBe(false);
  });

  it('`queue` does not imply `read`, so each is asked for by name', () => {
    expect(scopePermits(['queue'], 'read')).toBe(false);
  });

  it('and the clause it IS for still works', () => {
    expect(scopePermits(legacy, 'run')).toBe(true);
  });

  it('a coordinator token permits exactly what it names', () => {
    expect(scopePermits(['read', 'queue'], 'read')).toBe(true);
    expect(scopePermits(['read', 'queue'], 'queue')).toBe(true);
    expect(scopePermits(['read', 'queue'], 'claim')).toBe(false);
    expect(scopePermits(['read', 'queue'], 'run')).toBe(false);
  });

  it('a null scope set is still a hub credential, not a free pass to invent one', () => {
    // null means "not from agent_tokens at all" — a hub-issued agent token whose authority is
    // checked by the control pair. Unchanged by this work, asserted so it stays that way.
    expect(scopePermits(null, 'read')).toBe(true);
    expect(scopePermits(undefined, 'queue')).toBe(true);
  });
});
