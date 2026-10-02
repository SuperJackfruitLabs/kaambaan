import { describe, expect, it } from 'vitest';
import { AGENT_TOKEN_SCOPES, isAgentScope, type AgentScope } from '../src/scopes';

/**
 * The agent scope vocabulary.
 *
 * Two scopes said what an agent could do to a card it already held: `claim` and `run`. A
 * coordinator needs two more — to see the boards at all, and to put work on one — and the
 * difference between them is the difference between an observer and a co-signer, so they are
 * separate grants rather than one "coordinate" scope.
 *
 * `isAgentScope` is the one place that decides what a scope IS. The console mints narrowed
 * credentials by spelling a scope name, so a name this function rejects is a credential refused
 * at the far end with nothing connecting the two spellings.
 */
describe('agent scopes', () => {
  it('names four things an agent can be permitted', () => {
    for (const s of ['claim', 'run', 'read', 'queue'] satisfies AgentScope[]) {
      expect(isAgentScope(s)).toBe(true);
    }
  });

  it('rejects anything else, including near misses', () => {
    // `write` and `create` are the names someone reaches for when they mean `queue`; a silent
    // accept would mint a credential that permits nothing and fails far from here.
    for (const s of ['write', 'create', 'admin', 'queue ', 'Queue', '', null, undefined, 1, {}]) {
      expect(isAgentScope(s)).toBe(false);
    }
  });

  it('a default token still carries exactly claim and run', () => {
    // The new scopes are opt-in. Every caller that mints without asking for something narrower
    // must keep getting a worker's credential, not a coordinator's — this is the line between
    // "we added a capability" and "we widened every token in the fleet".
    expect(AGENT_TOKEN_SCOPES).toEqual(['claim', 'run']);
    expect(AGENT_TOKEN_SCOPES).not.toContain('read');
    expect(AGENT_TOKEN_SCOPES).not.toContain('queue');
  });
});
