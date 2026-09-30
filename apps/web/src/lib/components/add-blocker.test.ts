import { describe, it, expect } from 'vitest';
import { crossBoardNotice, submitAddBlocker, linkRefusalSentence } from './add-blocker';

describe('crossBoardNotice', () => {
  it('is null when the picked blocker is on this board — same-board edges are enforced, not advisory', () => {
    expect(crossBoardNotice('brd_1', 'brd_1')).toBeNull();
  });

  it('names the advisory consequence when the picked blocker is on a different board', () => {
    const notice = crossBoardNotice('brd_2', 'brd_1');
    expect(notice).not.toBeNull();
    expect(notice).toContain('advisory');
  });
});

describe('submitAddBlocker', () => {
  it('shows the advisory notice BEFORE the request is sent, for a cross-board pick', async () => {
    const order: string[] = [];
    const deps = {
      addLink: async (_boardId: string, _from: string, _to: string, _kind: 'blocks' | 'relates', _toBoardId?: string) => {
        order.push('request');
        return new Response(JSON.stringify({ link: {} }), { status: 201 });
      },
      notify: (message: string) => {
        order.push('notice:' + message);
      },
    };

    await submitAddBlocker(
      { blockerBoardId: 'brd_2', blockerCardId: 'card_x', thisBoardId: 'brd_1', thisCardId: 'card_c', kind: 'blocks' },
      deps,
    );

    expect(order).toHaveLength(2);
    expect(order[0]).toMatch(/^notice:/);
    expect(order[1]).toBe('request');
  });

  it('sends no notice for a same-board pick', async () => {
    const order: string[] = [];
    const deps = {
      addLink: async () => {
        order.push('request');
        return new Response(JSON.stringify({ link: {} }), { status: 201 });
      },
      notify: (message: string) => {
        order.push('notice:' + message);
      },
    };

    await submitAddBlocker(
      { blockerBoardId: 'brd_1', blockerCardId: 'card_x', thisBoardId: 'brd_1', thisCardId: 'card_c', kind: 'blocks' },
      deps,
    );

    expect(order).toEqual(['request']);
  });

  it('calls addLink with the blocker\'s own board as the path board, and toBoardId only when cross-board', async () => {
    let captured: unknown[] = [];
    const deps = {
      addLink: async (...args: unknown[]) => {
        captured = args;
        return new Response(JSON.stringify({ link: {} }), { status: 201 });
      },
      notify: () => {},
    };

    await submitAddBlocker(
      { blockerBoardId: 'brd_2', blockerCardId: 'card_x', thisBoardId: 'brd_1', thisCardId: 'card_c', kind: 'blocks' },
      deps,
    );

    expect(captured).toEqual(['brd_2', 'card_x', 'card_c', 'blocks', 'brd_1']);
  });
});

describe('linkRefusalSentence', () => {
  it('renders LINK_WOULD_CYCLE as a sentence naming the cycle, not the bare code', () => {
    const sentence = linkRefusalSentence(
      { code: 'LINK_WOULD_CYCLE', message: 'linking card_a -> card_b (blocks) would close a cycle' },
      409,
    );
    expect(sentence).not.toBe('LINK_WOULD_CYCLE');
    expect(sentence).toContain('cycle');
  });

  it('renders ALREADY_HAS_PARENT as a sentence naming the existing parent', () => {
    const sentence = linkRefusalSentence(
      { code: 'ALREADY_HAS_PARENT', message: 'card card_b already has a parent (card_z)' },
      409,
    );
    expect(sentence).not.toBe('ALREADY_HAS_PARENT');
    expect(sentence).toContain('card_z');
  });

  it('falls back to a generic sentence with the status when there is no server message', () => {
    expect(linkRefusalSentence(null, 500)).toContain('500');
  });
});
