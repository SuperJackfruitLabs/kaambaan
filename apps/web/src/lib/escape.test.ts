// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { closeCardOnEscape } from './escape';

describe('Escape closes the card, unless something inside already took it', () => {
  it('a plain Escape closes the card', () => {
    const close = vi.fn();
    closeCardOnEscape(new KeyboardEvent('keydown', { key: 'Escape' }), close);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('an Escape whose default was prevented (the embed closing its own panel) leaves the card open', () => {
    const close = vi.fn();
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    e.preventDefault();
    closeCardOnEscape(e, close);
    expect(close).not.toHaveBeenCalled();
  });
  it('other keys do nothing', () => {
    const close = vi.fn();
    closeCardOnEscape(new KeyboardEvent('keydown', { key: 'a' }), close);
    expect(close).not.toHaveBeenCalled();
  });
});
