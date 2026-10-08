// @vitest-environment jsdom
/**
 * The drawer's Resume panel: the human half of a block, on the card itself.
 *
 * Shown only when the card waits on a person for something resume can fix — not for an open
 * question (answer it) or a pending review (decide it), which have their own panels. The reason
 * detail is the agent's own text and arrives as text.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import CardResume from './CardResume.svelte';
import type { Card, Stage } from '$lib/api';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url) =>
    String(url).endsWith('/resume') ? new Response(JSON.stringify({ card: {}, comment: {} }), { status: 200 }) : new Response('{}', { status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STAGES: Stage[] = [
  { key: 'plan', name: 'Plan', order: 0, ownerKind: 'capability', owner: 'plan' },
  { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'build' },
  { key: 'review', name: 'Review', order: 2, ownerKind: 'human', gate: 'approval' },
];

const card = (over: Partial<Card>): Card => ({
  id: 'crd_1', title: 'Add login', ownerUserId: 'usr_a', currentStageKey: 'build', state: 'input-required', priority: 0,
  costUsd: 0, overBudget: false, attemptCount: 1, queuedBy: null, queuedByAgentId: null, queuedGrant: null, labels: [],
  dueAt: null, archivedAt: null, parentCardId: null, openChildCount: 0, costUsdRollup: 0, blockedBy: [], projectId: null,
  milestoneId: null, needsHuman: { reason: 'blocked', detail: 'the staging database is down' }, ...over,
});

/** The resume POST — the client may fetch a hub token first (`withAuthority`). */
const resumeCall = () => fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/resume'));

const props = (over: Record<string, unknown> = {}) => ({
  boardId: 'brd_1', card: card({}), stages: STAGES, gatePending: false, questionPending: false, onResumed: vi.fn(), ...over,
});

describe('CardResume', () => {
  it("shows why the card stopped, and resumes it to its stage with the comment", async () => {
    const p = props();
    render(CardResume, p);
    expect(screen.getByText('the staging database is down')).toBeTruthy();
    await fireEvent.input(screen.getByLabelText(/what changed/i), { target: { value: 'Staging is back' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send back to work' }));
    await waitFor(() => expect(p.onResumed).toHaveBeenCalled());
    const [url, init] = resumeCall()!;
    expect(String(url)).toBe('/v1/boards/brd_1/cards/crd_1/resume');
    expect(JSON.parse(init?.body as string)).toEqual({ comment: 'Staging is back' });
  });

  it('can send it to an earlier stage, and offers only this one and earlier ones', async () => {
    render(CardResume, props());
    const picker = screen.getByLabelText(/resume at/i) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(['build', 'plan']);
    await fireEvent.change(picker, { target: { value: 'plan' } });
    await fireEvent.input(screen.getByLabelText(/what changed/i), { target: { value: 'Re-plan' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send back to work' }));
    await waitFor(() => expect(resumeCall()).toBeTruthy());
    expect(JSON.parse(resumeCall()![1]?.body as string)).toEqual({ comment: 'Re-plan', toStageKey: 'plan' });
  });

  it("shows the server's refusal", async () => {
    fetchMock.mockImplementation(async (url) => !String(url).endsWith('/resume') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ error: { code: 'CARD_NOT_WAITING', message: 'a card in "submitted" is not waiting on anybody' } }), { status: 409 }));
    render(CardResume, props());
    await fireEvent.input(screen.getByLabelText(/what changed/i), { target: { value: 'go' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send back to work' }));
    expect(await screen.findByText(/not waiting on anybody/)).toBeTruthy();
  });

  it('is absent when the card is not waiting, or waits on a question or a review', () => {
    render(CardResume, props({ card: card({ state: 'working', needsHuman: undefined }) }));
    expect(screen.queryByRole('button', { name: 'Send back to work' })).toBeNull();
    cleanup();
    render(CardResume, props({ questionPending: true }));
    expect(screen.queryByRole('button', { name: 'Send back to work' })).toBeNull();
    cleanup();
    render(CardResume, props({ gatePending: true }));
    expect(screen.queryByRole('button', { name: 'Send back to work' })).toBeNull();
  });

  it('renders the reason as text, never as markup', () => {
    render(CardResume, props({ card: card({ needsHuman: { reason: 'blocked', detail: '<img src=x onerror="window.__p=1">' } }) }));
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror="window.__p=1">')).toBeTruthy();
  });
});
