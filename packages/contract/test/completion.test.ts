import { describe, it, expect } from 'vitest';
import { evaluateCompletion, type CompletionRequirement } from '../src/completion';

/**
 * What a stage may require of a run before the board believes it finished.
 *
 * `complete()` wrote `outcome = 'completed'` and advanced the card unconditionally: the handoff was
 * stored verbatim and never inspected, so an agent calling `complete` was the sole author of the
 * claim that its stage was done. On the one card that has run the Press board end to end that
 * claim was false twice — a board reporting `published` over a commit sitting unpushed on a
 * station, and `completed` for a run that explicitly refused to publish.
 */
const refs = (...rs: Array<{ provider: string; sourceType?: string }>) => rs;

describe('no requirement', () => {
  it('is met, so a board that declares nothing behaves exactly as before', () => {
    expect(evaluateCompletion(undefined, { handoff: null, references: [] })).toMatchObject({ met: true });
    expect(evaluateCompletion({}, { handoff: null, references: [] })).toMatchObject({ met: true });
  });
});

describe('required handoff keys', () => {
  const req: CompletionRequirement = { handoff: ['url', 'commit'] };

  it('is met when every key is present and carries something', () => {
    const v = evaluateCompletion(req, { handoff: { url: 'https://x.test', commit: 'abc123' }, references: [] });
    expect(v.met).toBe(true);
  });

  it('names the key that is missing, because "check failed" sends somebody to read source', () => {
    const v = evaluateCompletion(req, { handoff: { url: 'https://x.test' }, references: [] });
    expect(v.met).toBe(false);
    expect(v.reason).toContain('commit');
  });

  it('treats a present-but-empty key as missing — a blank is not a report', () => {
    for (const commit of ['', '   ', null, undefined]) {
      const v = evaluateCompletion(req, { handoff: { url: 'https://x.test', commit }, references: [] });
      expect(v.met, `commit=${JSON.stringify(commit)}`).toBe(false);
    }
  });

  it('refuses a handoff that is not an object at all', () => {
    expect(evaluateCompletion(req, { handoff: 'done!', references: [] }).met).toBe(false);
    expect(evaluateCompletion(req, { handoff: null, references: [] }).met).toBe(false);
  });
});

describe('a required reference', () => {
  it('is met by a reference of the named provider on the card', () => {
    const v = evaluateCompletion({ reference: { provider: 'forge' } }, {
      handoff: null,
      references: refs({ provider: 'forge', sourceType: 'pull_request' }),
    });
    expect(v.met).toBe(true);
  });

  it('is not met by a reference of a different provider', () => {
    const v = evaluateCompletion({ reference: { provider: 'forge' } }, {
      handoff: null,
      references: refs({ provider: 'github' }),
    });
    expect(v.met).toBe(false);
    expect(v.reason).toContain('forge');
  });

  it('can name a sourceType too, so "a pull request" is different from "any forge link"', () => {
    const req: CompletionRequirement = { reference: { provider: 'forge', sourceType: 'pull_request' } };
    expect(evaluateCompletion(req, { handoff: null, references: refs({ provider: 'forge', sourceType: 'repo' }) }).met).toBe(false);
    expect(evaluateCompletion(req, { handoff: null, references: refs({ provider: 'forge', sourceType: 'pull_request' }) }).met).toBe(true);
  });
});

describe('an arm this slice cannot evaluate', () => {
  it('is recorded as unchecked rather than passing silently', () => {
    // `live` is slice 3. A silent pass would be indistinguishable from a real verification, which
    // is the whole failure this programme exists to end.
    const v = evaluateCompletion({ live: 'url' }, { handoff: { url: 'https://x.test' }, references: [] });
    expect(v.met).toBe(true);
    expect(v.unchecked).toEqual([expect.stringContaining('live')]);
  });

  it('does not let an unchecked arm rescue a failing one', () => {
    const v = evaluateCompletion({ handoff: ['commit'], live: 'url' }, { handoff: {}, references: [] });
    expect(v.met).toBe(false);
    expect(v.unchecked?.length).toBe(1);
  });
});

describe('every failing arm is named at once', () => {
  it('so a person fixes both rather than discovering the second on the next run', () => {
    const v = evaluateCompletion(
      { handoff: ['url'], reference: { provider: 'forge' } },
      { handoff: {}, references: [] },
    );
    expect(v.met).toBe(false);
    expect(v.reason).toContain('url');
    expect(v.reason).toContain('forge');
  });
});
