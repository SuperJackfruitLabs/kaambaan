/**
 * The "Add blocker" dialogue's logic (Task 17b, Step 1b) — kept out of the `.svelte` file so it
 * can be tested without rendering (this project's Vitest config cannot import a `.svelte` file,
 * same reason `board/card-due.ts` exists beside `CardTile.svelte`).
 *
 * A cross-board pick must be told apart from a same-board one BEFORE the request is sent, never
 * after: a person who asks for a blocker and gets one that silently enforces nothing has already
 * been misled by the time any response comes back. `supi link add --to-board` prints its own
 * notice the same way, before its request (Task 17d) — this matches that intent.
 */

export type LinkKindChoice = 'blocks' | 'relates';

/**
 * Computed from the same board-id comparison the server's `…/links` route makes
 * (`toBoardId !== boardId`) — no round trip needed, since the dialogue already has both ids the
 * moment a board is picked.
 */
export function crossBoardNotice(blockerBoardId: string, thisBoardId: string): string | null {
  if (blockerBoardId === thisBoardId) return null;
  return 'This card is on another board — the edge will be advisory only: shown here, but not enforced, and the claim query will never see it.';
}

export interface AddBlockerParams {
  /** The board the PICKED (blocker) card lives on. */
  blockerBoardId: string;
  blockerCardId: string;
  /** This card's own board — always the enforced side of the edge. */
  thisBoardId: string;
  thisCardId: string;
  kind: LinkKindChoice;
}

export interface AddBlockerSubmitDeps {
  /** Same signature as `$lib/api`'s `addLink`. */
  addLink: (
    boardId: string,
    fromCardId: string,
    toCardId: string,
    kind: LinkKindChoice,
    toBoardId?: string,
  ) => Promise<Response>;
  notify: (message: string) => void;
}

/**
 * Submits the add-blocker request. `addLink`'s first argument is always the BLOCKER's own board —
 * the route requires `fromCardId` to live on the path board — with `toBoardId` naming this card's
 * board only when it differs, so the same call is same-board (enforced, DO) when the picked card
 * is on this board and cross-board (advisory, D1) otherwise. The notice (when it applies) is
 * printed before `addLink` is ever called.
 */
export async function submitAddBlocker(params: AddBlockerParams, deps: AddBlockerSubmitDeps): Promise<Response> {
  const notice = crossBoardNotice(params.blockerBoardId, params.thisBoardId);
  if (notice) deps.notify(notice);
  const toBoardId = params.blockerBoardId === params.thisBoardId ? undefined : params.thisBoardId;
  return deps.addLink(params.blockerBoardId, params.blockerCardId, params.thisCardId, params.kind, toBoardId);
}

/**
 * Surfaces the server's own refusal as a sentence — "invalid link" tells a person nothing about
 * what to do next, but the DO's own `message` already names the cards involved (`LINK_WOULD_CYCLE`
 * says which link would close the loop; `ALREADY_HAS_PARENT` names the existing parent). The
 * server's message is preferred whenever it is present; the switch below is only the fallback for
 * a response that somehow arrives without one.
 */
export function linkRefusalSentence(error: { code?: string; message?: string } | null | undefined, status: number): string {
  if (error?.message) return error.message;
  switch (error?.code) {
    case 'LINK_WOULD_CYCLE':
      return 'That would create a cycle of blockers.';
    case 'ALREADY_HAS_PARENT':
      return 'That card already has a parent — a card can only belong to one parent at a time.';
    case 'NO_SUCH_CARD':
      return "That card doesn't exist.";
    case 'FOREIGN_BOARD':
      return "That board isn't yours.";
    default:
      return `Couldn't add that link (${status}).`;
  }
}
