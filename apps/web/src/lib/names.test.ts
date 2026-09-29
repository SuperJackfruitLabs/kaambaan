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
