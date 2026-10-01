import { describe, it, expect, vi } from 'vitest';
import { renameLabel, recolourLabel, removeLabel, showsInferredBadge } from './label-manager';

function makeDeps() {
  return {
    updateLabel: vi.fn(async () => new Response(null, { status: 200 })),
    deleteLabel: vi.fn(async () => new Response(null, { status: 204 })),
  };
}

describe('renameLabel', () => {
  it('calls updateLabel with the label id and the trimmed name, nothing else', async () => {
    const deps = makeDeps();
    await renameLabel(deps, 'lbl_1', '  urgent  ');
    expect(deps.updateLabel).toHaveBeenCalledWith('lbl_1', { name: 'urgent' });
    expect(deps.updateLabel).toHaveBeenCalledTimes(1);
    expect(deps.deleteLabel).not.toHaveBeenCalled();
  });
});

describe('recolourLabel', () => {
  it('calls updateLabel with the label id and the new colour only', async () => {
    const deps = makeDeps();
    await recolourLabel(deps, 'lbl_1', '#ff6b57');
    expect(deps.updateLabel).toHaveBeenCalledWith('lbl_1', { colour: '#ff6b57' });
  });
});

describe('removeLabel', () => {
  it('calls deleteLabel with exactly the label id', async () => {
    const deps = makeDeps();
    await removeLabel(deps, 'lbl_1');
    expect(deps.deleteLabel).toHaveBeenCalledWith('lbl_1');
    expect(deps.deleteLabel).toHaveBeenCalledTimes(1);
    expect(deps.updateLabel).not.toHaveBeenCalled();
  });
});

describe('showsInferredBadge', () => {
  // The same treatment `CapabilitiesTab.svelte` already gives a capability's origin: only
  // `inferred` is called out with a badge — `declared` is the unremarkable default a label gets
  // by being named deliberately, and marking every row would bury the one fact an operator is
  // actually looking for ("which of these did nobody mean to create?").
  it('is true for a label that turned up from a typo in a card', () => {
    expect(showsInferredBadge('inferred')).toBe(true);
  });

  it('is false for a label someone named deliberately', () => {
    expect(showsInferredBadge('declared')).toBe(false);
  });
});
