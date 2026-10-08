// @vitest-environment jsdom
/**
 * The folds: a very deep value and a very long list are drawn in part with a way to see the rest,
 * never stringified and never dropped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/svelte';
import StructuredValue from './StructuredValue.svelte';

afterEach(() => cleanup());

function deepTree(levels: number): Record<string, unknown> {
  let deep: Record<string, unknown> = { leaf: 'bottom' };
  for (let i = levels - 1; i >= 0; i--) deep = { [`level${i}`]: deep };
  return deep;
}

describe('StructuredValue', () => {
  it('draws six levels in full', () => {
    render(StructuredValue, { value: deepTree(5) });
    expect(screen.getByText('bottom')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
  });

  it('folds deeper levels behind "Show more" instead of printing JSON', async () => {
    const { container } = render(StructuredValue, { value: deepTree(10) });
    expect(screen.queryByText('bottom')).toBeNull();
    expect(container.textContent).not.toContain('"leaf"');
    expect(container.textContent).not.toContain('{');
    const more = screen.getByRole('button', { name: /Show more/ });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(more);
    expect(screen.getByText('bottom')).toBeTruthy();
    expect(screen.getByText('Level9')).toBeTruthy();
  });

  it('shows the first eight items of a long list, then all of them on request', async () => {
    const items = Array.from({ length: 20 }, (_, i) => `step ${i + 1}`);
    render(StructuredValue, { value: items, testid: 'list' });
    const list = screen.getByTestId('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);
    expect(screen.queryByText('step 9')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Show all 20' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(20);
    expect(screen.getByText('step 20')).toBeTruthy();
  });
});
