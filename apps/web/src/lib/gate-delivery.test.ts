import { describe, expect, it } from 'vitest';
import { gateDecisionForOption } from './gate-delivery';

describe('gateDecisionForOption', () => {
  it.each([
    ['approve', 'approve'],
    ['approve_manual', 'approve_manual'],
    ['approve_automatic', 'approve_automatic'],
    ['request_changes', 'request_changes'],
    ['reject', 'reject'],
  ] as const)('keeps %s distinct on the wire', (option, expected) => {
    expect(gateDecisionForOption(option)).toBe(expected);
  });
});
