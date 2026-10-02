/**
 * Turning ids into names.
 *
 * The board showed `agt_2613e473e3934509` where it knew the agent was called research-ray, in six
 * places — a run's header, an attempt, an elicitation, a tile's answer button, the needs-you list
 * — while a seventh, Spend, resolved the name correctly. So the lookup existed and five sites
 * did it the long way or not at all, which is the argument for one function rather than a
 * `find()` repeated per component.
 */
import { describe, it, expect } from 'vitest';
import { displayAgent, displayPrincipal, shortId } from './names';
import { initialOf } from './components/agentColor';
import type { AgentSummary } from './api';

const AGENTS = [
  { id: 'agt_2613e473e3934509', name: 'research-ray', capabilities: ['research'] },
  { id: 'agt_ac912ef0a733446b', name: '', capabilities: [] },
];
const MEMBERS = [
  { userId: 'usr_b19776fac3c94df4', email: 'rakesh@example.test', name: 'Rakesh', role: 'owner' },
  { userId: 'usr_noname', email: 'someone@example.test', name: null, role: 'member' },
];

describe('displayAgent', () => {
  it('gives the name when the workspace knows it', () => {
    expect(displayAgent('agt_2613e473e3934509', AGENTS as never)).toBe('research-ray');
  });

  it('falls back to a SHORT id rather than nothing, so a row still identifies its worker', () => {
    // The agents list can lag, and a card can name an agent that has since been deleted.
    // Rendering an empty span would be worse than the id this change exists to replace.
    expect(displayAgent('agt_unknown0000000', AGENTS as never)).toBe('agt_…000000');
  });

  it('ignores a blank name, which is not a name', () => {
    expect(displayAgent('agt_ac912ef0a733446b', AGENTS as never)).toBe('agt_…33446b');
  });

  it('answers nothing for nothing', () => {
    expect(displayAgent(null, AGENTS as never)).toBe('');
    expect(displayAgent(undefined, [])).toBe('');
  });
});

describe('displayPrincipal', () => {
  it('names a workspace member', () => {
    expect(displayPrincipal('usr_b19776fac3c94df4', MEMBERS as never)).toBe('Rakesh');
  });

  it('uses the email when a member has no name set', () => {
    expect(displayPrincipal('usr_noname', MEMBERS as never)).toBe('someone@example.test');
  });

  it('shortens a principal from another plane rather than pretending to resolve it', () => {
    // A gate decided through AgentPod records a `prn_…` id whose directory lives in another
    // product. Inventing a name for it would be worse than admitting the id.
    expect(displayPrincipal('prn_34935f04668e4d089749', MEMBERS as never)).toBe('prn_…089749');
  });
});

describe('shortId', () => {
  it('keeps the prefix, which says what KIND of thing it is, and the tail, which distinguishes', () => {
    expect(shortId('agt_2613e473e3934509')).toBe('agt_…934509');
    expect(shortId('usr_b19776fac3c94df4')).toBe('usr_…c94df4');
  });

  it('leaves something already short alone', () => {
    expect(shortId('agt_1')).toBe('agt_1');
    expect(shortId('')).toBe('');
  });
});

describe('initialOf, given what the card drawer used to pass it', () => {
  it('letters an avatar from the NAME, so two agents do not share one letter', () => {
    // The drawer header took its initial from the raw `agt_…`, so every agent on the board got
    // an avatar lettered "A" — the `a` of `agt_`. The fix is to resolve the name first; this
    // pins the difference that makes.
    const agents = [
      { id: 'agt_267d3618110a419b', name: 'coder-kai' },
      { id: 'agt_9f1c2b3a4d5e6f70', name: 'writer-quill' },
    ] as AgentSummary[];

    expect(initialOf(displayAgent('agt_267d3618110a419b', agents))).toBe('C');
    expect(initialOf(displayAgent('agt_9f1c2b3a4d5e6f70', agents))).toBe('W');
    // The bug, stated: both of these were the same letter.
    expect(initialOf('agt_267d3618110a419b')).toBe(initialOf('agt_9f1c2b3a4d5e6f70'));
  });

  it('an agent the board does not know falls back to a short id, not to nothing', () => {
    expect(displayAgent('agt_267d3618110a419b', [])).toBe(shortId('agt_267d3618110a419b'));
    expect(initialOf(displayAgent('agt_267d3618110a419b', []))).not.toBe('');
  });
});

describe('displayPrincipal resolves an AGENT principal too', () => {
  // A card queued by an agent records ITS `prn_…`, not a user id, so the members list can never
  // name it — and `queued by prn_d8178f4a…` is exactly the id-instead-of-a-name this module exists
  // to stop. The agents list already carries `externalId`, which is that same principal.
  const COORDINATOR = [
    { id: 'agt_coord', name: 'Coordinator', capabilities: ['command'], externalId: 'prn_coord000000000001' },
  ];

  it('names the agent behind a principal id', () => {
    expect(displayPrincipal('prn_coord000000000001', MEMBERS as never, COORDINATOR as never)).toBe('Coordinator');
  });

  it('prefers a member, because a human and an agent never share an id space', () => {
    expect(displayPrincipal('usr_b19776fac3c94df4', MEMBERS as never, COORDINATOR as never)).toBe('Rakesh');
  });

  it('still shortens a principal nothing here knows', () => {
    expect(displayPrincipal('prn_34935f04668e4d089749', MEMBERS as never, COORDINATOR as never)).toBe('prn_…089749');
  });

  it('is unchanged when no agents are passed, so every existing call site behaves as before', () => {
    expect(displayPrincipal('prn_coord000000000001', MEMBERS as never)).toBe('prn_…000001');
  });

  it('ignores an agent with no mapping rather than matching null to null', () => {
    // An unmapped agent has `externalId: null`. If the lookup compared loosely, asking about a
    // null principal would match the first unmapped agent in the workspace and name the wrong one.
    const unmapped = [{ id: 'agt_x', name: 'Unmapped', capabilities: [], externalId: null }];
    expect(displayPrincipal(null, MEMBERS as never, unmapped as never)).toBe('');
  });
});
