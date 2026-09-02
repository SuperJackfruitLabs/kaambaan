import { describe, it, expect } from 'vitest';
import { capabilityTag, capabilityTags } from '../src/primitives';

/**
 * Routing is `agent.capabilities.includes(stage.owner)` — exact equality between two free
 * strings. Until this function existed, three code paths each spelled a capability differently,
 * so a stage named "Code Review" (owner `code-review`) could never be matched by an agent whose
 * operator typed "Code Review" into the capability field (`code review`).
 */
describe('a capability has one spelling', () => {
  it('produces the same tag from the spellings a person actually types', () => {
    for (const written of ['Code Review', 'code review', ' CODE  REVIEW ', 'code-review', 'Code_Review']) {
      expect(capabilityTag(written)).toBe('code-review');
    }
  });

  it('matches what a board template makes of a stage name', () => {
    // NewBoardDialog derives a stage's owner from its name with the same rule.
    expect(capabilityTag('Deploy')).toBe('deploy');
    expect(capabilityTag('QA / Test')).toBe('qa-test');
  });

  it('trims the separators it introduces rather than leaving a tag nothing equals', () => {
    expect(capabilityTag('  triage!  ')).toBe('triage');
    expect(capabilityTag('---')).toBe('');
  });

  it('drops empties and duplicates from a set, keeping order', () => {
    expect(capabilityTags(['Code', 'code', '', '  ', 'Test'])).toEqual(['code', 'test']);
  });
});
