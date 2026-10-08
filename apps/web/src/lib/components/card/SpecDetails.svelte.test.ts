// @vitest-environment jsdom
/**
 * A card's spec is whatever its author wrote, and the agent working the card receives all of
 * it. The drawer used to show three fields (description, plan, acceptance criteria) and drop
 * the rest on the floor, so a person reviewing the card could not see what the agent was told.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/svelte';
import SpecDetails from './SpecDetails.svelte';

/** Shaped like a coordinator's card: a role brief, nested decisions, operator to-dos. */
const COORDINATOR_SPEC = {
  description: 'Stand up the new reviewer persona.',
  acceptanceCriteria: ['Persona file merged'],
  plan: [{ t: 'Draft', done: true }],
  labels: ['persona'],
  due: '2026-10-10',
  role: 'Release reviewer',
  character: 'Calm, exacting, writes short sentences. Never approves on vibes.',
  authority: 'May request changes; may not merge.',
  requirements: [
    'Reads every diff before commenting',
    'Links evidence: https://docs.example.com/review-guide',
    'Escalates security findings within one hour',
  ],
  portraitDecision: {
    style: 'flat illustration',
    approved: false,
    candidates: 3,
    reference: 'https://images.example.com/portrait/ref-01.png',
    palette: { primary: 'marigold', secondary: 'ink' },
  },
  operatorActions: [
    { action: 'Grant review scope', owner: 'operator', done: false },
    { action: 'Pick a portrait', owner: 'operator', done: true },
  ],
  maxConcurrentReviews: 2,
  unattended: true,
};

afterEach(() => cleanup());

describe('SpecDetails', () => {
  it('renders every field the drawer does not already render, with humanised labels', () => {
    render(SpecDetails, { spec: COORDINATOR_SPEC, hasDescription: true });
    const section = screen.getByTestId('spec-details');
    for (const label of ['Role', 'Character', 'Authority', 'Requirements', 'Portrait decision', 'Operator actions', 'Max concurrent reviews', 'Unattended']) {
      expect(within(section).getAllByText(label).length, label).toBeGreaterThan(0);
    }
    expect(within(section).getByText('Release reviewer')).toBeTruthy();
    expect(within(section).getByText('May request changes; may not merge.')).toBeTruthy();
  });

  it('does not repeat description, plan, acceptance criteria, labels or due', () => {
    render(SpecDetails, { spec: COORDINATOR_SPEC, hasDescription: true });
    const section = screen.getByTestId('spec-details');
    for (const label of ['Description', 'Plan', 'Acceptance criteria', 'Labels', 'Due']) {
      expect(within(section).queryByText(label), label).toBeNull();
    }
    expect(within(section).queryByText('Stand up the new reviewer persona.')).toBeNull();
  });

  it('renders arrays as bullet lists', () => {
    render(SpecDetails, { spec: COORDINATOR_SPEC, hasDescription: true });
    const list = screen.getByTestId('spec-value-requirements');
    expect(list.tagName).toBe('UL');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('Reads every diff before commenting')).toBeTruthy();
  });

  it('renders nested objects as labelled groups, recursively', () => {
    render(SpecDetails, { spec: COORDINATOR_SPEC, hasDescription: true });
    const group = screen.getByTestId('spec-value-portraitDecision');
    expect(within(group).getByText('Style')).toBeTruthy();
    expect(within(group).getByText('flat illustration')).toBeTruthy();
    expect(within(group).getByText('Palette')).toBeTruthy();
    expect(within(group).getByText('Primary')).toBeTruthy();
    expect(within(group).getByText('marigold')).toBeTruthy();
    // booleans and numbers plain
    expect(within(group).getByText('false')).toBeTruthy();
    expect(within(group).getByText('3')).toBeTruthy();
  });

  it('renders an array of objects as one group per item', () => {
    render(SpecDetails, { spec: COORDINATOR_SPEC, hasDescription: true });
    const list = screen.getByTestId('spec-value-operatorActions');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Grant review scope')).toBeTruthy();
    expect(within(items[0]!).getByText('Owner')).toBeTruthy();
  });

  it('links http(s) URLs, alone or inside prose', () => {
    render(SpecDetails, { spec: COORDINATOR_SPEC, hasDescription: true });
    const ref = screen.getByRole('link', { name: 'https://images.example.com/portrait/ref-01.png' });
    expect(ref.getAttribute('href')).toBe('https://images.example.com/portrait/ref-01.png');
    expect(ref.getAttribute('rel')).toContain('noopener');
    const inline = screen.getByRole('link', { name: 'https://docs.example.com/review-guide' });
    expect(inline.getAttribute('href')).toBe('https://docs.example.com/review-guide');
  });

  it('never makes a link out of a javascript: URL', () => {
    render(SpecDetails, { spec: { callback: 'javascript:alert(1)' }, hasDescription: true });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('javascript:alert(1)')).toBeTruthy();
  });

  it('renders markup in a spec string as text, not as elements', () => {
    const evil = '<script>window.__pwned = true</script><img src=x onerror="window.__pwned=true">';
    const { container } = render(SpecDetails, { spec: { note: evil }, hasDescription: true });
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(evil)).toBeTruthy();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('caps the depth of nested objects instead of recursing forever', () => {
    let deep: Record<string, unknown> = { leaf: 'bottom' };
    for (let i = 0; i < 12; i++) deep = { [`level${i}`]: deep };
    const { container } = render(SpecDetails, { spec: { tree: deep }, hasDescription: true });
    // The tail beyond the cap is shown as compact JSON, still readable.
    expect(container.textContent).toContain('"leaf":"bottom"');
    expect(container.querySelectorAll('dl').length).toBeLessThanOrEqual(6);
  });

  it('is open by default when the card has no description', () => {
    render(SpecDetails, { spec: COORDINATOR_SPEC, hasDescription: false });
    const details = screen.getByTestId('spec-details').querySelector('details');
    expect(details?.open).toBe(true);
  });

  it('collapses a long spec when there is a description above it', () => {
    render(SpecDetails, { spec: COORDINATOR_SPEC, hasDescription: true });
    const details = screen.getByTestId('spec-details').querySelector('details');
    expect(details?.open).toBe(false);
  });

  it('stays open for a short spec even with a description', () => {
    render(SpecDetails, { spec: { role: 'Release reviewer' }, hasDescription: true });
    const details = screen.getByTestId('spec-details').querySelector('details');
    expect(details?.open).toBe(true);
  });

  it('renders nothing when there is nothing beyond the drawer-owned fields', () => {
    render(SpecDetails, { spec: { description: 'only this', acceptanceCriteria: ['x'] }, hasDescription: true });
    expect(screen.queryByTestId('spec-details')).toBeNull();
  });
});
