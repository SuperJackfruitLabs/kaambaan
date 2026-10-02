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
    // question of whether an agent may spend other agents' time.
    expect(requiredScope('cards', 'POST')).toBe('queue');
    expect(requiredScope('cards', 'POST')).not.toBe(requiredScope('cards/card_1', 'GET'));
  });

  it('THE METHOD IS PART OF THE GATE: `read` is not a licence to edit or delete', () => {
    // The first cut of this took only the path, so `read` would have authorised PATCH and DELETE
    // on the very same route it was meant to let an agent LOOK at. A scope that permits more than
    // its name is how a read-only credential quietly becomes a write one.
    //
    // Editing a card later became a real capability (`plan`), so PATCH on a card is no longer
    // refused outright — it is refused to a `read` token, which is what this test was ever about.
    // The protection moved from "nothing may do this" to "not with that scope", and both halves are
    // asserted: the verdict here, and `scopePermits(['read'], 'plan') === false` below.
    for (const method of ['PATCH', 'DELETE', 'PUT']) {
      expect(requiredScope('', method)).toBe('__forbidden__');
    }
    for (const method of ['DELETE', 'PUT']) {
      expect(requiredScope('cards/card_1', method)).toBe('__forbidden__');
    }
    expect(requiredScope('cards/card_1', 'PATCH')).toBe('plan');
    expect(scopePermits(['read'], 'plan')).toBe(false);
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

describe('`plan` rearranges work that already exists', () => {
  it('gates a card EDIT on `plan`, where reading it is `read`', () => {
    // The same path, two different trusts. Reading a card tells you what is happening; editing it
    // changes what the workspace is doing, and a `read` credential must not be able to.
    expect(requiredScope('cards/card_1', 'GET')).toBe('read');
    expect(requiredScope('cards/card_1', 'PATCH')).toBe('plan');
  });

  it('gates MOVING a card on `plan` — and the grant check happens elsewhere', () => {
    // A move into a dispatchable stage IS a dispatch (`moveCard` stamps `queued_by`/`queued_grant`).
    // The scope says who may rearrange; `authorizeAgentQueue` says on whose authority. Both, because
    // a scope alone would let an agent launder a human's grant onto work it chose.
    expect(requiredScope('cards/card_1/move', 'POST')).toBe('plan');
  });

  it('has no card-LIST route to gate — the board snapshot is the list', () => {
    // Checked against the router rather than assumed: `rest === 'cards'` serves POST only, so a
    // `read` verdict here would refuse an agent on a scope for a route that answers 405 to everyone.
    expect(requiredScope('cards', 'GET')).toBe('__forbidden__');
  });

  it('gates links on `plan` — "this waits on that" is a coordinator\'s main tool', () => {
    expect(requiredScope('links', 'POST')).toBe('plan');
    expect(requiredScope('links', 'DELETE')).toBe('plan');
  });

  it('reads a card\'s history on `read`', () => {
    for (const sub of ['activities', 'attempts', 'estimate']) {
      expect(requiredScope(`cards/card_1/${sub}`, 'GET')).toBe('read');
    }
  });

  it('STILL FORBIDS deleting a card or a board, on any scope', () => {
    expect(requiredScope('cards/card_1', 'DELETE')).toBe('__forbidden__');
    expect(requiredScope('', 'DELETE')).toBe('__forbidden__');
    expect(requiredScope('', 'PATCH')).toBe('__forbidden__');
  });

  it('STILL FORBIDS resolving a gate — the human half of the control pair', () => {
    // The boundary the audit trail hangs from. An agent holding both halves makes every "a human
    // decided this" record unverifiable, including the record of its own work.
    expect(requiredScope('gates/gate_1/resolve', 'POST')).toBe('__forbidden__');
  });

  it('STILL FORBIDS restructuring the board', () => {
    // Changing stages re-routes every card and can strand work outright.
    for (const rest of ['stages', 'stages/review']) {
      for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        expect(requiredScope(rest, m)).toBe('__forbidden__');
      }
    }
  });

  it('a `plan` token cannot queue, and a `queue` token cannot plan', () => {
    expect(scopePermits(['plan'], 'queue')).toBe(false);
    expect(scopePermits(['queue'], 'plan')).toBe(false);
    // And neither is implied by the worker pair — the grandfather regression, a third time.
    expect(scopePermits(['claim', 'run'], 'plan')).toBe(false);
  });

  it('a coordinator holding all three permits exactly those three', () => {
    const c = ['read', 'queue', 'plan'];
    for (const s of ['read', 'queue', 'plan'] as const) expect(scopePermits(c, s)).toBe(true);
    for (const s of ['claim', 'run'] as const) expect(scopePermits(c, s)).toBe(false);
  });
});
