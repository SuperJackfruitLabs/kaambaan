// @vitest-environment jsdom
/**
 * One Needs-you row: what is wrong, what to do, and the actions for it.
 *
 * The detail is an agent's own words, or a handoff's — text anyone who can run an agent can write,
 * shown to everyone who opens the panel. It must arrive as text.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import AttentionRow from './AttentionRow.svelte';
import type { AttentionItem } from './attention';
import type { Stage } from '$lib/api';

afterEach(cleanup);

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  id: 'x', kind: 'blocked', boardId: 'brd_1', boardName: 'Releases', cardId: 'crd_1', title: 'Add login', stageKey: 'build',
  headline: 'stopped and is waiting on you', detail: 'the staging database is down',
  instruction: 'Read why it stopped, fix that, then resume it with a note the agent will read.',
  actions: ['resume', 'open'], ageHours: 3, ...over,
});

const STAGES: Stage[] = [
  { key: 'requested', name: 'Requested', order: 0, ownerKind: 'human' },
  { key: 'build', name: 'Build', order: 1, ownerKind: 'capability', owner: 'build' },
];

function setup(it: AttentionItem, extra: Record<string, unknown> = {}) {
  const onOpen = vi.fn();
  const onResume = vi.fn(async () => null as string | null);
  const onMove = vi.fn(async () => null as string | null);
  render(AttentionRow, { item: it, stages: STAGES, onOpen, onResume, onMove, ...extra });
  return { onOpen, onResume, onMove };
}

describe('AttentionRow', () => {
  it('says what happened, in the card\'s words, and what to do', () => {
    setup(item({}));
    expect(screen.getByText('Add login')).toBeTruthy();
    expect(screen.getByText('the staging database is down')).toBeTruthy();
    expect(screen.getByText(/fix that, then resume it/)).toBeTruthy();
    expect(screen.getByText('blocked')).toBeTruthy();
  });

  it('Resume opens a comment box, sends the comment, and refuses an empty one', async () => {
    const { onResume } = setup(item({}));
    await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    const box = screen.getByLabelText(/what changed/i) as HTMLTextAreaElement;
    const send = screen.getByRole('button', { name: 'Send back to work' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await fireEvent.input(box, { target: { value: 'Staging is back' } });
    expect(send.disabled).toBe(false);
    await fireEvent.click(send);
    await waitFor(() => expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'crd_1' }), 'Staging is back'));
  });

  it("shows the server's refusal when resume is refused", async () => {
    const onResume = vi.fn(async () => 'this card is waiting on a review — decide it instead');
    setup(item({}), { onResume });
    await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await fireEvent.input(screen.getByLabelText(/what changed/i), { target: { value: 'go' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Send back to work' }));
    expect(await screen.findByText(/decide it instead/)).toBeTruthy();
  });

  it('a review row shows what is being approved and opens the card — there is no Approve here', async () => {
    const { onOpen } = setup(item({ kind: 'review', detail: 'Adds the login form and its tests', actions: ['review'], headline: 'review · waiting for your review' }));
    expect(screen.getByText('Adds the login form and its tests')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('repeated failure offers Resume and Open log', () => {
    setup(item({ kind: 'repeated-failure', actions: ['resume', 'log'], headline: 'failed 2 times in a row' }));
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open log' })).toBeTruthy();
  });

  it('refused keeps Staff an agent as a link', () => {
    setup(item({ kind: 'refused', actions: ['staff'] }));
    expect(screen.getByRole('link', { name: 'Staff an agent' }).getAttribute('href')).toBe('/workspace/capabilities');
  });

  it('an ownerless-stage row moves the card with a stage picker that leaves out where it is', async () => {
    const { onMove } = setup(item({ kind: 'no-owner', stageKey: 'requested', headline: 'Nothing claims stage requested', detail: null, actions: ['move', 'open'] }));
    expect(screen.getByText(/Nothing claims stage requested/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    const picker = screen.getByLabelText(/move to/i) as HTMLSelectElement;
    expect([...picker.options].filter((o) => !o.disabled).map((o) => o.value)).toEqual(['build']);
    await fireEvent.change(picker, { target: { value: 'build' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Move card' }));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'crd_1' }), 'build'));
  });

  it('cuts a long detail short, with a control to read the rest', async () => {
    const long = 'x'.repeat(150) + ' END-OF-DETAIL';
    setup(item({ detail: long }));
    expect(screen.queryByText(/END-OF-DETAIL/)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByText(/END-OF-DETAIL/)).toBeTruthy();
  });

  it('renders markup in the detail and the title as the text it is', () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    setup(item({ detail: evil, title: '<b>bold</b>' }));
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByText(evil)).toBeTruthy();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
