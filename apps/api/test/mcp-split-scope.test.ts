import { describe, it, expect } from 'vitest';
import { TOOL_SCOPE } from '../src/mcp/tools';

describe('superpipeline_split_card scope', () => {
  it('is run-scoped, not claim-scoped', () => {
    // `claim` is the roster credential the bridge holds; `run` is what a dispatched agent holds for
    // the one card it is working. Decomposition is something an agent does to ITS card mid-run, so
    // it belongs to `run`. Scoped to `claim` it would be handed to the thing that should only be
    // taking work, which is the separation #622 established with two credentials per agent.
    expect(TOOL_SCOPE.superpipeline_split_card).toBe('run');
  });

  it('leaves claim_card the only tool a run-only token cannot reach', () => {
    const runnable = Object.entries(TOOL_SCOPE)
      .filter(([, scope]) => scope !== 'run')
      .map(([name]) => name);
    // Verified live in #622: tools/list with a run-only token returned 11 tools and withheld
    // exactly superpipeline_claim_card. Adding split_card must not change that count by widening
    // anything else.
    expect(runnable).toEqual(['superpipeline_claim_card']);
  });
});
