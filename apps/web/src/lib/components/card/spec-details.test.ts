import { describe, it, expect } from 'vitest';
import { humaniseKey, safeHref, specDetailEntries, splitLinks, isLongSpec } from './spec-details';

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
