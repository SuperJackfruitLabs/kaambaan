import { describe, it, expect } from 'vitest';
import {
  humaniseKey, safeHref, specDetailEntries, splitLinks, isLongSpec,
  MAX_DEPTH, LIST_PREVIEW, inlineParts, listWindow, nestedEntries, normaliseValue, parseJsonString, rawJson, shouldCollapse,
} from './spec-details';

describe('humaniseKey', () => {
  it('turns camelCase into a sentence-case label', () => {
    expect(humaniseKey('portraitDecision')).toBe('Portrait decision');
    expect(humaniseKey('operatorActions')).toBe('Operator actions');
  });
  it('handles snake_case, kebab-case and single words', () => {
    expect(humaniseKey('due_by_date')).toBe('Due by date');
    expect(humaniseKey('max-retries')).toBe('Max retries');
    expect(humaniseKey('role')).toBe('Role');
  });
  it('keeps an acronym readable', () => {
    expect(humaniseKey('prURL')).toBe('Pr URL');
    expect(humaniseKey('apiKeyID')).toBe('Api key ID');
  });
});

describe('safeHref', () => {
  it('accepts http and https URLs', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('http://example.com')).toBe('http://example.com/');
  });
  it('refuses every other scheme and non-URLs', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('JavaScript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHref('mailto:a@example.com')).toBeNull();
    expect(safeHref('example.com')).toBeNull();
    expect(safeHref('just some words')).toBeNull();
  });
});

describe('splitLinks', () => {
  it('splits prose around http(s) URLs and leaves the rest as text', () => {
    expect(splitLinks('see https://example.com/x, then reply')).toEqual([
      { text: 'see ' },
      { text: 'https://example.com/x', href: 'https://example.com/x' },
      { text: ', then reply' },
    ]);
  });
  it('never links a javascript: URL in prose', () => {
    expect(splitLinks('click javascript:alert(1)')).toEqual([{ text: 'click javascript:alert(1)' }]);
  });
});

describe('specDetailEntries', () => {
  it('skips the fields the drawer already renders or owns', () => {
    const entries = specDetailEntries({
      description: 'd',
      plan: [{ t: 'a', done: false }],
      acceptanceCriteria: ['x'],
      labels: ['l'],
      due: '2026-01-01',
      role: 'Coordinator',
    });
    expect(entries.map((e) => e.key)).toEqual(['role']);
  });
  it('skips empty values but keeps false and 0', () => {
    const entries = specDetailEntries({ a: null, b: '', c: [], d: {}, e: false, f: 0, g: undefined });
    expect(entries.map((e) => e.key)).toEqual(['e', 'f']);
  });
  it('returns nothing for a missing spec', () => {
    expect(specDetailEntries(undefined)).toEqual([]);
    expect(specDetailEntries(null)).toEqual([]);
  });
});

describe('isLongSpec', () => {
  it('is short for a couple of small fields', () => {
    expect(isLongSpec([{ key: 'role', value: 'Coordinator' }])).toBe(false);
  });
  it('is long for many fields or a lot of text', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, value: 'v' }));
    expect(isLongSpec(many)).toBe(true);
    expect(isLongSpec([{ key: 'essay', value: 'x'.repeat(2000) }])).toBe(true);
  });
});

/* ── The shared readable renderer: Details, and every handoff the drawer shows ───────────── */


describe('humaniseKey on handoff keys', () => {
  it('spells out the keys agents write in handoffs', () => {
    expect(humaniseKey('codeGrounding')).toBe('Code grounding');
    expect(humaniseKey('inspectedRepository')).toBe('Inspected repository');
    expect(humaniseKey('existingCapabilities')).toBe('Existing capabilities');
  });
  it('leaves a key that is a path, a repository or a sentence exactly as written', () => {
    expect(humaniseKey('SuperJackfruitLabs/super-jackfruit-website')).toBe('SuperJackfruitLabs/super-jackfruit-website');
    expect(humaniseKey('apps/web/src/lib')).toBe('apps/web/src/lib');
    expect(humaniseKey('runs.handoff_json')).toBe('runs.handoff_json');
    expect(humaniseKey('Already a label')).toBe('Already a label');
  });
});

describe('parseJsonString', () => {
  it('reads a string that is wholly a JSON object or array', () => {
    expect(parseJsonString('{"decision":"ship","n":2}')).toEqual({ decision: 'ship', n: 2 });
    expect(parseJsonString('  ["a", "b"]\n')).toEqual(['a', 'b']);
  });
  it('leaves every other string alone', () => {
    expect(parseJsonString('"quoted"')).toBeNull();
    expect(parseJsonString('42')).toBeNull();
    expect(parseJsonString('true')).toBeNull();
    expect(parseJsonString('null')).toBeNull();
    expect(parseJsonString('see {"a":1} here')).toBeNull();
    expect(parseJsonString('{"a":1} trailing')).toBeNull();
    expect(parseJsonString('{not json}')).toBeNull();
    expect(parseJsonString('[unclosed')).toBeNull();
    expect(parseJsonString('')).toBeNull();
  });
  it('never evaluates anything', () => {
    (globalThis as { __ran?: boolean }).__ran = undefined;
    expect(parseJsonString('[(globalThis.__ran = true)]')).toBeNull();
    expect((globalThis as { __ran?: boolean }).__ran).toBeUndefined();
  });
});

describe('normaliseValue', () => {
  it('turns a JSON-document string into its value and leaves the rest', () => {
    expect(normaliseValue('{"in":["x"]}')).toEqual({ in: ['x'] });
    expect(normaliseValue('plain words')).toBe('plain words');
    expect(normaliseValue(3)).toBe(3);
    const o = { a: 1 };
    expect(normaliseValue(o)).toBe(o);
  });
});

describe('nestedEntries', () => {
  it('keeps nulls and empties inside a value (shown as a dash) and drops only undefined', () => {
    expect(nestedEntries({ a: null, b: '', c: undefined, d: 0 }).map((e) => e.key)).toEqual(['a', 'b', 'd']);
  });
});

describe('shouldCollapse', () => {
  it('draws six levels and collapses nested values below that', () => {
    expect(MAX_DEPTH).toBe(6);
    expect(shouldCollapse({ a: 1 }, MAX_DEPTH - 1)).toBe(false);
    expect(shouldCollapse({ a: 1 }, MAX_DEPTH)).toBe(true);
    expect(shouldCollapse([1], MAX_DEPTH)).toBe(true);
  });
  it('never collapses a leaf, however deep', () => {
    expect(shouldCollapse('text', MAX_DEPTH + 3)).toBe(false);
    expect(shouldCollapse(null, MAX_DEPTH + 3)).toBe(false);
  });
});

describe('listWindow', () => {
  const items = Array.from({ length: 20 }, (_, i) => `item ${i}`);
  it('shows the first eight of a long list and counts the rest', () => {
    expect(LIST_PREVIEW).toBe(8);
    const w = listWindow(items, false);
    expect(w.shown).toEqual(items.slice(0, 8));
    expect(w.hidden).toBe(12);
  });
  it('shows everything once asked', () => {
    expect(listWindow(items, true)).toEqual({ shown: items, hidden: 0 });
  });
  it('does not hide one or two items behind a button', () => {
    expect(listWindow(items.slice(0, 10), false).hidden).toBe(0);
    expect(listWindow(items.slice(0, 11), false).hidden).toBe(3);
  });
});

describe('inlineParts', () => {
  it('turns backticked spans into code and links URLs outside them', () => {
    expect(inlineParts('run `pnpm test` then see https://example.com/x.')).toEqual([
      { text: 'run ' },
      { text: 'pnpm test', code: true },
      { text: ' then see ' },
      { text: 'https://example.com/x', href: 'https://example.com/x' },
      { text: '.' },
    ]);
  });
  it('does not link a URL inside a code span', () => {
    expect(inlineParts('`https://example.com`')).toEqual([{ text: 'https://example.com', code: true }]);
  });
  it('leaves an unmatched backtick as text', () => {
    expect(inlineParts('it`s fine')).toEqual([{ text: 'it`s fine' }]);
  });
});

describe('rawJson', () => {
  it('pretty-prints and never throws', () => {
    expect(rawJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(typeof rawJson(cyclic)).toBe('string');
  });
});
