// @vitest-environment jsdom
/**
 * The stepper watches the lanes that are there NOW.
 *
 * Switching boards keeps the board screen mounted and swaps its lanes for new elements. The
 * observer was attached once, when the scroller first appeared, so it went on watching detached
 * lanes that never scroll again and the selected tab froze (reported from a phone, 2026-10-07).
 *
 * jsdom has no layout, so `IntersectionObserver` is replaced by one the test drives by hand: what
 * is under test is which elements are observed and what an intersection does to the tabs.
 *
 * It renders the real `BoardKanban` and changes `app.board`, the way the board switcher does,
 * rather than re-rendering the stepper with new props: the test harness re-sets every prop on a
 * rerender, which re-ran the old effect and hid the bug.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import type { BoardSnapshot, Stage } from '$lib/api';
import { app } from '$lib/stores/app.svelte';
import BoardKanban from '$lib/components/board/BoardKanban.svelte';

class FakeObserver {
  static live: FakeObserver[] = [];
  observed = new Set<Element>();
  constructor(private cb: (entries: Partial<IntersectionObserverEntry>[]) => void) {
    FakeObserver.live.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  disconnect() {
    this.observed.clear();
    FakeObserver.live = FakeObserver.live.filter((o) => o !== this);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  takeRecords() {
    return [];
  }
  /** Report `el` as on screen (or off), to whichever live observer is watching it. */
  static show(el: Element, isIntersecting = true) {
    for (const o of FakeObserver.live) if (o.observed.has(el)) o.cb([{ target: el, isIntersecting }]);
  }
  static watching(el: Element) {
    return FakeObserver.live.some((o) => o.observed.has(el));
  }
}

function snapshot(prefix: string, names: string[]): BoardSnapshot {
  const stages = names.map((n, i) => ({ key: `${prefix}-${n}`, name: `${n} ${prefix}`, order: i }) as Stage);
  return { boardId: `brd_${prefix}`, name: prefix, stages, cards: [], gates: [], elicitations: [], references: [] } as unknown as BoardSnapshot;
}

const lanes = () => [...document.querySelectorAll<HTMLElement>('[data-lane]')];
const selected = () => screen.getAllByRole('tab').findIndex((t) => t.getAttribute('aria-selected') === 'true');

describe('the stage tabs', () => {
  beforeEach(() => {
    FakeObserver.live = [];
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
    Element.prototype.scrollIntoView = () => {}; // jsdom has no layout to scroll
    app.board = snapshot('one', ['Backlog', 'Build', 'Done']);
  });
  afterEach(() => {
    cleanup();
    app.board = null;
  });

  it('follow the lane on screen', () => {
    render(BoardKanban);
    FakeObserver.show(lanes()[1]);
    flushSync();
    expect(selected()).toBe(1);
  });

  it('follow the new lanes after the board changes under them', () => {
    render(BoardKanban);
    const before = lanes();

    app.board = snapshot('two', ['Backlog', 'Build', 'Done']);
    flushSync();
    const after = lanes();
    expect(after[1]).not.toBe(before[1]); // new elements, as a different board's stages give

    expect(FakeObserver.watching(after[1])).toBe(true);
    FakeObserver.show(after[1]);
    flushSync();
    expect(selected()).toBe(1);
  });

  it('stop watching lanes that are gone', () => {
    render(BoardKanban);
    const before = lanes();
    app.board = snapshot('two', ['Backlog', 'Build', 'Done']);
    flushSync();
    expect(before.some((l) => FakeObserver.watching(l))).toBe(false);
  });

  it('follow a stage added to the board while it is open', () => {
    render(BoardKanban);
    app.board = snapshot('one', ['Backlog', 'Build', 'Review', 'Done']);
    flushSync();
    const review = lanes()[2];
    expect(FakeObserver.watching(review)).toBe(true);
    FakeObserver.show(review);
    flushSync();
    expect(selected()).toBe(2);
  });
});
