import { describe, it, expect } from 'vitest';
import { parseElicitationOptions } from '../src/board/elicitation';

/**
 * The options a human picks from come out of the activity's `parameter` (docs/04 §4) — the only
 * field the board carries. Harnesses spell an option differently, so we normalize what we can and
 * drop only what carries no answerable name.
 */
describe('parseElicitationOptions', () => {
  const canonical = [
    { name: 'run_them', title: 'Run the tests' },
    { name: 'skip', title: 'Skip them' },
  ];

  it('reads the canonical `{ options: [{name,title}] }` shape', () => {
    expect(parseElicitationOptions({ options: canonical })).toEqual(canonical);
  });

  it('reads a bare array of options', () => {
    expect(parseElicitationOptions(canonical)).toEqual(canonical);
  });

  it('accepts the `{id,label}` spelling and normalizes it', () => {
    expect(parseElicitationOptions({ options: [{ id: 'approve', label: 'Approve' }] })).toEqual([
      { name: 'approve', title: 'Approve' },
    ]);
  });

  it('accepts a bare string as both name and title', () => {
    expect(parseElicitationOptions(['yes', 'no'])).toEqual([
      { name: 'yes', title: 'yes' },
      { name: 'no', title: 'no' },
    ]);
  });

  it('carries promptFill and interactive through', () => {
    expect(parseElicitationOptions({ options: [{ name: 'other', title: 'Something else', promptFill: 'Instead, ', interactive: true }] })).toEqual([
      { name: 'other', title: 'Something else', promptFill: 'Instead, ', interactive: true },
    ]);
  });

  it('keeps the first spelling of a duplicated name — resolution is by name', () => {
    expect(parseElicitationOptions([{ name: 'yes', title: 'Yes' }, { name: 'yes', title: 'Also yes' }])).toEqual([
      { name: 'yes', title: 'Yes' },
    ]);
  });

  it('drops entries with no answerable name, and unrecognized payloads', () => {
    expect(parseElicitationOptions({ options: [{ title: 'nameless' }, '', 42, null, { name: 'ok', title: 'OK' }] })).toEqual([
      { name: 'ok', title: 'OK' },
    ]);
    expect(parseElicitationOptions({ question: 'no options here' })).toEqual([]);
    expect(parseElicitationOptions(null)).toEqual([]);
    expect(parseElicitationOptions(undefined)).toEqual([]);
    expect(parseElicitationOptions('just a string')).toEqual([]);
  });
});
