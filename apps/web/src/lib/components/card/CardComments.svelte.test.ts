// @vitest-environment jsdom
/**
 * The card drawer's comment thread.
 *
 * What matters most here is the second test: a comment is text anyone with board read access —
 * or an agent — can write, and it is shown to everyone who opens the card. Rendered as HTML, one
 * comment would run script in every viewer's session.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import CardComments from './CardComments.svelte';
import type { BoardFeedEvent, CardComment } from '$lib/api';

const base = (over: Partial<CardComment>): CardComment => ({
  id: 'cmt_1',
  cardId: 'crd_1',
  author: { kind: 'human', id: 'usr_a', name: 'Asha' },
  body: 'hello',
  createdAt: '2026-10-08T10:00:00.000Z',
  deletedAt: null,
  ...over,
});

let thread: CardComment[];
const fetchMock = vi.fn<typeof fetch>();
let feed: ((e: BoardFeedEvent) => void) | null;
const onFeed = (fn: (e: BoardFeedEvent) => void) => {
  feed = fn;
  return () => {
    feed = null;
  };
};

beforeEach(() => {
  thread = [];
  feed = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string).body as string;
      const c = base({ id: `cmt_${thread.length + 1}`, body, author: { kind: 'human', id: 'usr_me', name: 'Me' } });
      thread.push(c);
      return new Response(JSON.stringify({ comment: c }), { status: 201 });
    }
    if (init?.method === 'DELETE') {
      const id = u.split('/').pop()!;
      thread = thread.map((c) => (c.id === id ? { ...c, body: '', deletedAt: '2026-10-08T11:00:00.000Z' } : c));
      return new Response(JSON.stringify({ comment: thread.find((c) => c.id === id) }), { status: 200 });
    }
    return new Response(JSON.stringify({ comments: thread }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const props = { boardId: 'brd_1', cardId: 'crd_1', currentUserId: 'usr_me', onFeed, coalesceMs: 0 };

describe('CardComments', () => {
  it('lists each comment with its author, whether a person or an agent wrote it, and when', async () => {
    thread = [
      base({ body: 'Please cover the expired path' }),
      base({ id: 'cmt_2', author: { kind: 'agent', id: 'agt_b', name: 'Builder' }, body: 'On it' }),
    ];
    render(CardComments, props);
    expect(await screen.findByText('Please cover the expired path')).toBeTruthy();
    expect(screen.getByText('Asha')).toBeTruthy();
    expect(screen.getByText('Builder')).toBeTruthy();
    expect(screen.getByText('agent')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(document.querySelector('time[datetime="2026-10-08T10:00:00.000Z"]')).toBeTruthy();
  });

  it('shows markup as the text it is: no element, no script, no handler is created from a comment', async () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><b>bold</b>';
    thread = [base({ body: evil })];
    const { container } = render(CardComments, props);
    expect(await screen.findByText(evil)).toBeTruthy();
    const list = container.querySelector('[data-testid="comment-list"]')!;
    expect(list.querySelector('img, script, b')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('posts from the composer and shows the new comment', async () => {
    render(CardComments, props);
    const box = await screen.findByLabelText('Add a comment');
    await fireEvent.input(box, { target: { value: 'Looks right to me' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByText('Looks right to me')).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')!;
    expect(String(post[0])).toBe('/v1/boards/brd_1/cards/crd_1/comments');
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('shows the server’s refusal instead of pretending it posted', async () => {
    fetchMock.mockImplementation(async (_u, init) =>
      init?.method === 'POST'
        ? new Response(JSON.stringify({ error: { code: 'INVALID_COMMENT', message: 'a comment is at most 8192 bytes' } }), { status: 400 })
        : new Response(JSON.stringify({ comments: [] }), { status: 200 }),
    );
    render(CardComments, props);
    const box = await screen.findByLabelText('Add a comment');
    await fireEvent.input(box, { target: { value: 'x' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect((await screen.findByRole('alert')).textContent).toContain('8192 bytes');
  });

  it('refetches when the live feed says this card’s thread changed, and ignores other cards', async () => {
    render(CardComments, props);
    await screen.findByLabelText('Add a comment');
    await waitFor(() => expect(feed).not.toBeNull());
    const reads = () => fetchMock.mock.calls.filter(([, i]) => !i?.method).length;
    const before = reads();

    feed!({ seq: 1, type: 'card.comment.added', payload: { cardId: 'crd_other', commentId: 'cmt_9' }, ts: '' });
    await new Promise((r) => setTimeout(r, 5));
    expect(reads()).toBe(before);

    thread = [base({ body: 'from another tab' })];
    feed!({ seq: 2, type: 'card.comment.added', payload: { cardId: 'crd_1', commentId: 'cmt_1' }, ts: '' });
    expect(await screen.findByText('from another tab')).toBeTruthy();
  });

  it('offers delete on your own comments only, and shows a deleted one as deleted', async () => {
    thread = [base({ id: 'cmt_mine', author: { kind: 'human', id: 'usr_me', name: 'Me' }, body: 'mine' }), base({ id: 'cmt_theirs', body: 'theirs' })];
    render(CardComments, props);
    await screen.findByText('mine');
    const deletes = screen.getAllByRole('button', { name: /Delete/ });
    expect(deletes).toHaveLength(1);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await fireEvent.click(deletes[0]!);
    expect(await screen.findByText('Comment deleted')).toBeTruthy();
    expect(screen.queryByText('mine')).toBeNull();
  });
});
