// @vitest-environment jsdom
/**
 * A handoff is what one stage's agent concluded, and the next stage (and the person reviewing the
 * card) reads it. The drawer printed each top-level key and `JSON.stringify`-ed its value, so a
 * planning handoff — `approach.codeGrounding.existingCapabilities: […]`, `scope.in/out: […]` —
 * reached a phone as one wall of braces and escaped quotes. These hold it to reading as a document.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/svelte';
import HandoffView from './HandoffView.svelte';

/** Shaped like card_d4fcd4ab9cb44de1's planning handoffs (abridged, same nesting). */
const PLANNING_HANDOFF = {
  problem:
    'Guild work is split between Forge, GitHub, local profile trees, ad-hoc clones and card worktrees, so operators cannot reliably answer where unfinished work lives.',
  approach: {
    decision: 'Forge is canonical; checkpoints go to card branches on the product repository.',
    codeGrounding: {
      inspectedRepository: 'SuperJackfruitLabs/agentpod at `apps/node/src/station.ts`',
      existingCapabilities: [
        'Station discovery, workspace paths and health',
        'fs/terminal capabilities',
        'Credential-exposure scanning',
      ],
      demonstratedGaps: [
        { gap: 'No managed Git worktrees', evidence: 'https://forge.superjackfruit.com/SuperJackfruitLabs/agentpod' },
        { gap: 'No verified pushes', evidence: 'station capabilities list' },
      ],
    },
  },
  scope: {
    in: ['Inventory all 32 registered profiles/stations', 'Define Forge as canonical for Guild work'],
    out: ['Minting keys or granting membership', 'Deleting the private GitHub repository'],
    auditBaseline: {
      forgeReadProbes: {
        'SuperJackfruitLabs/super-jackfruit-website': 'readable (coder-kai)',
        'SuperJackfruitLabs/agentpod': 'not readable',
      },
    },
  },
  alternatives: '[{"option":"GitHub as fallback","rejected":"no implicit public mirror"},{"option":"Whole-profile backup","rejected":"secrets"}]',
  refusedHandoff: null,
  reviewed: false,
  estimateHours: 12,
};

afterEach(() => cleanup());

describe('HandoffView', () => {
  it('reads a nested planning handoff as labelled groups, not JSON', () => {
    const { container } = render(HandoffView, { handoff: PLANNING_HANDOFF, testid: 'handoff' });
    const root = screen.getByTestId('handoff');
    for (const label of ['Problem', 'Approach', 'Decision', 'Code grounding', 'Inspected repository', 'Existing capabilities', 'Demonstrated gaps', 'Scope', 'In', 'Out']) {
      expect(within(root).getAllByText(label).length, label).toBeGreaterThan(0);
    }
    // No JSON punctuation anywhere in the rendered (non-raw) document.
    const text = root.querySelector('[data-structured]')!.textContent ?? '';
    expect(text).not.toContain('{"');
    expect(text).not.toContain('":');
    expect(container.querySelector('pre')).toBeNull();
  });

  it('draws an array of strings as a bullet list', () => {
    render(HandoffView, { handoff: PLANNING_HANDOFF, testid: 'handoff' });
    const caps = screen.getByText('Credential-exposure scanning').closest('ul')!;
    expect(caps).toBeTruthy();
    expect(within(caps).getAllByRole('listitem')).toHaveLength(3);
  });

  it('draws an array of objects as numbered groups', () => {
    render(HandoffView, { handoff: PLANNING_HANDOFF, testid: 'handoff' });
    const gaps = screen.getByText('No managed Git worktrees').closest('ol')!;
    expect(gaps).toBeTruthy();
    expect(within(gaps).getAllByRole('listitem')).toHaveLength(2);
    expect(within(gaps).getAllByText('Gap')).toHaveLength(2);
  });

  it('reads a value that is a JSON document stored as a string', () => {
    render(HandoffView, { handoff: PLANNING_HANDOFF, testid: 'handoff' });
    expect(screen.getByText('GitHub as fallback')).toBeTruthy();
    expect(screen.getAllByText('Rejected')).toHaveLength(2);
    expect(screen.queryByText(/\[\{"option"/)).toBeNull();
  });

  it('reads a whole handoff that is a JSON string', () => {
    render(HandoffView, { handoff: JSON.stringify({ summary: 'done', next: 'review' }), testid: 'handoff' });
    expect(screen.getByText('Summary')).toBeTruthy();
    expect(screen.getByText('review')).toBeTruthy();
  });

  it('keeps a key that names a repository as written', () => {
    render(HandoffView, { handoff: PLANNING_HANDOFF, testid: 'handoff' });
    expect(screen.getByText('SuperJackfruitLabs/super-jackfruit-website')).toBeTruthy();
  });

  it('shows null as a dash and booleans and numbers plain', () => {
    render(HandoffView, { handoff: PLANNING_HANDOFF, testid: 'handoff' });
    const refused = screen.getByText('Refused handoff').closest('div')!;
    expect(within(refused).getByText('—')).toBeTruthy();
    expect(screen.getByText('false')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
  });

  it('turns backticked spans into inline code and URLs into safe links', () => {
    render(HandoffView, { handoff: PLANNING_HANDOFF, testid: 'handoff' });
    const code = screen.getByText('apps/node/src/station.ts');
    expect(code.tagName).toBe('CODE');
    const link = screen.getByRole('link', { name: 'https://forge.superjackfruit.com/SuperJackfruitLabs/agentpod' });
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows the raw JSON on request, as copyable text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = render(HandoffView, { handoff: { summary: 'done' }, testid: 'handoff' });
    expect(container.querySelector('pre')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'View raw JSON' }));
    expect(container.querySelector('pre')!.textContent).toBe('{\n  "summary": "done"\n}');
    await fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('{\n  "summary": "done"\n}');
  });

  it('renders nothing for an empty handoff', () => {
    render(HandoffView, { handoff: null, testid: 'handoff' });
    expect(screen.queryByTestId('handoff')).toBeNull();
  });

  it('renders markup in keys and values — and inside JSON strings — as text', () => {
    const evil = '<script>window.__pwned = true</script><img src=x onerror="window.__pwned=true">';
    const { container } = render(HandoffView, {
      handoff: {
        [evil]: evil,
        nested: { [evil]: [evil, `\`${evil}\``] },
        doc: JSON.stringify({ [evil]: evil }),
        link: 'javascript:alert(1)',
      },
      testid: 'handoff',
    });
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getAllByText(evil).length).toBeGreaterThanOrEqual(5);
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});
