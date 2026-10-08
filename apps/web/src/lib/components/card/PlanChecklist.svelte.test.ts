// @vitest-environment jsdom
/**
 * Agents write `spec.plan` in more than one shape. A plan of plain strings (as on
 * card_a5b92fd10c4d4a15) used to render four blank checkboxes and "0 / 4 steps".
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/svelte';
import PlanChecklist from './PlanChecklist.svelte';
import SpecDetails from './SpecDetails.svelte';

const STRING_PLAN = [
  'Shape the two channel paths and the independent community-feedback path; distinguish content briefs, final copy, review, human approval and execution.',
  'Inspect SuperPipeline code, supported handoff/routing/gate contracts and event hooks, AgentPod station execution and existing xurl integration before choosing an implementation. Do not assume automatic lane skipping or arbitrary branching exists.',
  'Design exact-copy approved payloads, reliable publication and verification, manual LinkedIn tracking, recurring planning and event-driven intake. State alternatives and blast radius.',
  'Publish an accessible architecture/spec and staged implementation cards proposal, including human-owned stage/roster decisions, test fixtures and acceptance evidence. Stop at the planning approval gate, not implementation.',
];

afterEach(() => cleanup());

describe('PlanChecklist', () => {
  it('shows the text of every step of a plan written as plain strings', () => {
    render(PlanChecklist, { plan: STRING_PLAN });
    const section = screen.getByTestId('plan-checklist');
    for (const step of STRING_PLAN) expect(within(section).getByText(step)).toBeTruthy();
    expect(within(section).getByText('0 / 4 steps · 0%')).toBeTruthy();
  });

  it('ticks and counts done steps in the { t, done } shape', () => {
    render(PlanChecklist, { plan: [{ t: 'Draft', done: true }, { t: 'Ship', done: false }] });
    const section = screen.getByTestId('plan-checklist');
    expect(within(section).getByText('Draft')).toBeTruthy();
    expect(within(section).getByText('1 / 2 steps · 50%')).toBeTruthy();
  });

  it('renders nothing when no item has text', () => {
    render(PlanChecklist, { plan: ['', { done: true }] });
    expect(screen.queryByTestId('plan-checklist')).toBeNull();
  });
});

describe('plan under Details', () => {
  it('stays hidden from Details when the checklist rendered all of it', () => {
    render(SpecDetails, { spec: { description: 'd', plan: STRING_PLAN, role: 'r' }, hasDescription: true });
    expect(within(screen.getByTestId('spec-details')).queryByText('Plan')).toBeNull();
  });

  it('shows the raw plan under Details when the checklist could not render it', () => {
    render(SpecDetails, { spec: { description: 'd', plan: [{ owner: 'quill' }] }, hasDescription: true });
    const section = screen.getByTestId('spec-details');
    expect(within(section).getByText('Plan')).toBeTruthy();
    expect(within(section).getByText('quill')).toBeTruthy();
  });
});
