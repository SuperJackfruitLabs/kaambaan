import type { GateDecision } from './api';

/** Preserve the approval delivery choice selected by the human on the wire. */
export function gateDecisionForOption(option: string): GateDecision {
  if (
    option === 'approve' ||
    option === 'approve_manual' ||
    option === 'approve_automatic' ||
    option === 'request_changes' ||
    option === 'reject'
  ) {
    return option;
  }
  throw new TypeError(`unsupported gate option: ${option}`);
}
