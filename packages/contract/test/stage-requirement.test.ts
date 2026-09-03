import { describe, expect, it } from 'vitest';
import {
  normalizeRequirement,
  stageCapabilitiesMet,
  stageRequiredCapabilities,
} from '../src/primitives';

describe('normalizeRequirement', () => {
  it('normalises every member with the one spelling', () => {
    expect(normalizeRequirement({ all: ['Code Review', 'SECURITY'] })).toEqual({
      all: ['code-review', 'security'],
    });
  });

  it('drops empties and duplicates', () => {
    expect(normalizeRequirement({ any: ['code', '', 'code', '  '] })).toEqual({ any: ['code'] });
  });

  it('is null when it constrains nothing, so the caller falls back to owner', () => {
    // A stray `{}` from the editor must not mean "nobody may claim". That would turn an empty
    // object into a lane no agent can work, which is the failure this area exists to end.
    expect(normalizeRequirement({})).toBeNull();
    expect(normalizeRequirement({ all: [], any: [] })).toBeNull();
    expect(normalizeRequirement(undefined)).toBeNull();
  });
});

describe('stageCapabilitiesMet', () => {
  it('falls back to owner when there is no requirement', () => {
    expect(stageCapabilitiesMet({ owner: 'code' }, ['code', 'test'])).toBe(true);
    expect(stageCapabilitiesMet({ owner: 'code' }, ['test'])).toBe(false);
  });

  it('a human stage with no owner and no requirement is claimable by nobody', () => {
    expect(stageCapabilitiesMet({}, ['code'])).toBe(false);
  });

  it('all: every member must be held', () => {
    const stage = { requires: { all: ['code', 'security'] } };
    expect(stageCapabilitiesMet(stage, ['code', 'security', 'test'])).toBe(true);
    expect(stageCapabilitiesMet(stage, ['code'])).toBe(false);
  });

  it('any: one member is enough', () => {
    const stage = { requires: { any: ['python', 'typescript'] } };
    expect(stageCapabilitiesMet(stage, ['typescript'])).toBe(true);
    expect(stageCapabilitiesMet(stage, ['go'])).toBe(false);
  });

  it('all and any together both bind', () => {
    const stage = { requires: { all: ['code'], any: ['python', 'typescript'] } };
    expect(stageCapabilitiesMet(stage, ['code', 'python'])).toBe(true);
    expect(stageCapabilitiesMet(stage, ['python'])).toBe(false); // missing the `all`
    expect(stageCapabilitiesMet(stage, ['code', 'go'])).toBe(false); // satisfies no `any`
  });

  it('requires wins over owner when both are present', () => {
    const stage = { owner: 'code', requires: { all: ['security'] } };
    expect(stageCapabilitiesMet(stage, ['security'])).toBe(true);
    expect(stageCapabilitiesMet(stage, ['code'])).toBe(false);
  });

  it('matching is exact equality, not similarity', () => {
    expect(stageCapabilitiesMet({ requires: { all: ['code-review'] } }, ['code'])).toBe(false);
  });
});

describe('stageRequiredCapabilities', () => {
  it('reports the owner when there is no requirement', () => {
    expect(stageRequiredCapabilities({ owner: 'code' })).toEqual(['code']);
  });

  it('reports every member of a requirement, both arms', () => {
    expect(
      stageRequiredCapabilities({ requires: { all: ['code'], any: ['python', 'typescript'] } }),
    ).toEqual(['code', 'python', 'typescript']);
  });

  it('reports nothing for a human stage', () => {
    expect(stageRequiredCapabilities({})).toEqual([]);
  });
});
