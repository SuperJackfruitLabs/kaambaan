/**
 * The single shared reactive store for the flight-deck UI (Svelte 5 runes in a module).
 *
 * It owns the *shared* state — board snapshot, auth, the board switcher, the active screen, the
 * view toggle, filters, the open card, the command palette — plus the mutation+refresh loop and the
 * live WebSocket. Modal-local transient state (budget inputs, agent-mint form, card-edit form) stays
 * inside the components that own it. Ported from the original monolithic `+page.svelte`.
 */
import {
  getMe,
  getBoard,
  getBoards,
  getNotifications,
  getAgents,
  createBoard,
  createCard,
  moveCard,
  openBoardSocket,
  deleteBoard,
  BOARD_TEMPLATES,
  type BoardSnapshot,
  type BoardSummary,
  type Card,
  type Gate,
  type Elicitation,
  type Reference,
  type Notification,
  type User,
  type AgentSummary,
} from '$lib/api';

const BOARD_KEY = 'kaambaan.boardId';
const THEME_KEY = 'kaambaan.theme';

export type Theme = 'dark' | 'light';
export type View = 'board' | 'list';
export type ListGroupBy = 'stage' | 'state' | 'owner' | 'priority';
export interface CardFilters {
  states: string[];
  owners: string[];
  minPriority: number | null;
  needsReview: boolean;
  live: boolean;
  overBudget: boolean;
}

class AppStore {
  // auth + onboarding
  authState = $state<'loading' | 'signed-out' | 'ready'>('loading');
  user = $state<User | null>(null);
  needsBoard = $state(false);

  // boards
  boards = $state<BoardSummary[]>([]);
  boardId = $state<string | null>(null);
  board = $state<BoardSnapshot | null>(null);
  connected = $state(false);

  /**
   * The one request the command palette still makes of a component it does not own.
   *
   * Its other two — "open the agents panel" and "go to Triage" — are addresses now, so the palette
   * navigates instead of signalling. Composing is not an address: it is a sheet over whatever you
   * are looking at, and only the board header can open it.
   *
   * A counter rather than a boolean, so asking twice in a row is two requests: a flag that is
   * already true cannot be raised again.
   */
  composeRequest = $state(0);

  requestCompose(): void {
    this.composeRequest += 1;
  }
  error = $state<string | null>(null);

  // collaboration data
  notifications = $state<Notification[]>([]);
  agents = $state<AgentSummary[]>([]);

  // navigation + view
  theme = $state<Theme>('dark');
  view = $state<View>('board');
  listGroupBy = $state<ListGroupBy>('stage');
  filters = $state<CardFilters>({ states: [], owners: [], minPriority: null, needsReview: false, live: false, overBudget: false });

  // overlays
  openCardId = $state<string | null>(null);
  /**
   * Whether the navigation rail is showing on a narrow screen.
   *
   * Only meaningful below `md`, where the rail is an overlay. At desktop
   * widths it is always visible and this is ignored — the alternative was a
   * second piece of state meaning "collapsed on desktop", which is a different
   * feature nobody asked for.
   *
   * Lives here rather than inside `Rail.svelte` because more than the rail
   * closes it: choosing a screen does, and so should anything that navigates.
   */
  cmdkOpen = $state(false);

  #socket: WebSocket | undefined;
  /**
   * Reconnection state for the live feed.
   *
   * A dropped WebSocket showed "offline" until the user reloaded the page — no retry, no polling
   * fallback. A live board that silently stops being live is worse than one that never claimed to
   * be: the cards on screen keep looking current.
   *
   * `#socketGeneration` is what makes a stale timer harmless. Switching boards or disposing
   * bumps it, so a reconnect scheduled for the previous board finds its generation stale and
   * returns rather than opening a socket onto a board nobody is looking at.
   */
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempt = 0;
  #socketGeneration = 0;

  // ---- derived reads (methods stay reactive when read in templates) ----
  boardStates(): string[] {
    return this.board ? [...new Set(this.board.cards.map((c) => c.state))].sort() : [];
  }
  boardOwners(): string[] {
    return this.board ? [...new Set(this.board.cards.map((c) => c.ownerUserId))].sort() : [];
  }
  filteredCards(): Card[] {
    const b = this.board;
    if (!b) return [];
    const f = this.filters;
    return b.cards.filter((c) => {
      if (f.states.length && !f.states.includes(c.state)) return false;
      if (f.owners.length && !f.owners.includes(c.ownerUserId)) return false;
      if (f.minPriority !== null && c.priority < f.minPriority) return false;
      if (f.needsReview && !b.gates.some((g) => g.cardId === c.id) && !b.elicitations.some((e) => e.cardId === c.id))
        return false;
      if (f.live && c.state !== 'working') return false;
      if (f.overBudget && !c.overBudget) return false;
      return true;
    });
  }
  unreadCount(): number {
    return this.notifications.filter((n) => !n.read).length;
  }
  cardById(id: string): Card | undefined {
    return this.board?.cards.find((c) => c.id === id);
  }
  gateForCard(id: string): Gate | undefined {
    return this.board?.gates.find((g) => g.cardId === id && g.status === 'pending');
  }
  /** The question an agent is waiting on a human to answer for this card, if any (docs/04 §4). */
  elicitationForCard(id: string): Elicitation | undefined {
    return this.board?.elicitations.find((e) => e.cardId === id && e.status === 'pending');
  }
  referencesForCard(id: string): Reference[] {
    return this.board?.references.filter((r) => r.cardId === id) ?? [];
  }
  /** The "Needs You" triage queue: cards at a pending gate or question, over budget, or failed. */
  needsYou(): Card[] {
    const cards = this.board?.cards ?? [];
    return cards.filter(
      (c) => this.gateForCard(c.id) || this.elicitationForCard(c.id) || c.overBudget || c.state === 'failed',
    );
  }

  // ---- actions ----
  /**
   * Boot the board.
   *
   * `preferred` is what the URL asked for. **It wins over the remembered
   * board**, and that ordering is the whole point of addressable cards: a link
   * someone was sent has to open what it names, not whatever board they
   * happened to have open last. Getting this the other way round produces a
   * link that appears to work — it loads a board — while showing the wrong one.
   *
   * A preferred board that does not resolve falls back to the remembered one
   * rather than erroring. Stale links are the normal case: a gate lives in a
   * Matrix room forever, and the board it names can be deleted long after.
   */
  async init(preferred?: { boardId?: string | null; cardId?: string | null }): Promise<void> {
    this.initTheme();
    try {
      this.user = await getMe();
      if (!this.user) {
        this.authState = 'signed-out';
        return;
      }
      this.authState = 'ready';

      let id: string | null = null;
      if (preferred?.boardId) {
        try {
          await getBoard(preferred.boardId);
          id = preferred.boardId;
        } catch {
          // Deleted, or another tenant's — the API answers 404 to both, by
          // construction, so this cannot tell them apart and must not try.
          id = null;
        }
      }

      if (!id) {
        id = localStorage.getItem(BOARD_KEY);
        if (id) {
          try {
            await getBoard(id);
          } catch {
            id = null;
            localStorage.removeItem(BOARD_KEY);
          }
        }
      }
      if (!id) {
        await this.loadBoards();
        id = this.boards[0]?.id ?? null;
      }
      if (!id) {
        this.needsBoard = true;
        return;
      }
      await this.openBoard(id);

      // Only after the board is loaded, and only if the card is really on it.
      // A drawer opened on a card the snapshot does not contain renders empty,
      // which reads as a broken card rather than a stale link.
      if (preferred?.cardId && id === preferred.boardId) {
        this.openCardId = this.board?.cards.some((c) => c.id === preferred.cardId)
          ? preferred.cardId
          : null;
      }
    } catch (e) {
      this.error = String(e);
    }
  }

  async loadBoards(): Promise<void> {
    try {
      this.boards = await getBoards();
    } catch {
      /* the switcher list is best-effort */
    }
  }

  async openBoard(id: string): Promise<void> {
    this.boardId = id;
    this.needsBoard = false;
    localStorage.setItem(BOARD_KEY, id);
    await this.refresh();
    await this.loadBoards();
    try {
      this.agents = await getAgents();
    } catch {
      this.agents = [];
    }
    this.#connect(id);
  }

  /**
   * Open the live feed, and keep it open.
   *
   * Backoff is capped at 30s and jittered: every viewer of a board loses the socket at the same
   * moment when a Worker restarts, and a fixed delay would have them all return in the same
   * instant.
   */
  #connect(boardId: string): void {
    this.#closeSocket();
    const generation = this.#socketGeneration;
    const sock = openBoardSocket(boardId, () => this.refresh());
    sock.addEventListener('open', () => {
      if (generation !== this.#socketGeneration) return;
      this.connected = true;
      this.#reconnectAttempt = 0;
    });
    sock.addEventListener('close', () => {
      if (generation !== this.#socketGeneration) return;
      this.connected = false;
      const delay = Math.min(30_000, 1000 * 2 ** this.#reconnectAttempt) * (0.75 + Math.random() * 0.5);
      this.#reconnectAttempt += 1;
      this.#reconnectTimer = setTimeout(() => {
        if (generation !== this.#socketGeneration) return;
        // Refresh on the way back: whatever happened while the socket was down did not reach us,
        // and reconnecting to a live feed with a stale board is the same lie in slower form.
        void this.refresh();
        this.#connect(boardId);
      }, delay);
    });
    this.#socket = sock;
  }

  /** Close the socket and cancel any pending reconnect, invalidating both for good measure. */
  #closeSocket(): void {
    this.#socketGeneration += 1;
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#socket?.close();
    this.#socket = undefined;
  }

  async switchBoard(id: string): Promise<void> {
    if (id !== this.boardId) await this.openBoard(id);
  }

  async refresh(): Promise<void> {
    if (!this.boardId) return;
    try {
      this.board = await getBoard(this.boardId);
      this.notifications = await getNotifications(this.boardId);
    } catch (e) {
      this.error = String(e);
    }
  }

  /**
   * Queue a card.
   *
   * `detail` is optional because the one-line dispatch is a real and common act — but the API has
   * always accepted priority and a spec, and the compose form captured neither, so a card could
   * only ever be created bare and then edited. Everything the drawer can set, the compose form can
   * now set at creation.
   */
  async dispatchCard(title: string, detail?: { priority?: number; description?: string; due?: string }): Promise<void> {
    if (!this.boardId || title.trim() === '') return;
    try {
      const spec: Record<string, unknown> = {};
      if (detail?.description && detail.description.trim() !== '') spec.description = detail.description.trim();
      if (detail?.due && detail.due.trim() !== '') spec.due = detail.due.trim();
      await createCard(this.boardId, title.trim(), {
        priority: detail?.priority,
        spec: Object.keys(spec).length > 0 ? spec : undefined,
      });
      await this.refresh();
    } catch (e) {
      this.error = String(e);
    }
  }

  async moveCard(cardId: string, toStageKey: string): Promise<void> {
    if (!this.boardId) return;
    const res = await moveCard(this.boardId, cardId, toStageKey);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      this.error = body?.error?.message ?? `Move failed (${res.status})`;
    } else {
      this.error = null;
    }
    await this.refresh();
  }

  async deleteBoard(id: string): Promise<void> {
    const res = await deleteBoard(id);
    if (!res.ok) {
      this.error = `Couldn't delete that board (${res.status})`;
      return;
    }
    await this.loadBoards();
    if (id === this.boardId) {
      const next = this.boards[0];
      if (next) {
        await this.openBoard(next.id);
      } else {
        this.boardId = null;
        this.board = null;
        localStorage.removeItem(BOARD_KEY);
        this.needsBoard = true;
        this.#socket?.close();
      }
    }
  }

  /** Returns the new board's id so the caller can navigate to it — every screen is a route now. */
  async createFirstBoard(): Promise<string | null> {
    try {
      const id = await createBoard('My first board', BOARD_TEMPLATES[0]!.stages);
      await this.openBoard(id);
      return id;
    } catch (e) {
      this.error = String(e);
      return null;
    }
  }

  openCard(id: string): void {
    this.openCardId = id;
  }
  closeCard(): void {
    this.openCardId = null;
  }
  /** Mirror the theme the inline app.html script already applied to <html> into reactive state. */
  initTheme(): void {
    const current = document.documentElement.getAttribute('data-theme');
    this.theme = current === 'light' ? 'light' : 'dark';
  }
  setTheme(t: Theme): void {
    this.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* private mode / storage disabled — the toggle still works for this session */
    }
  }
  toggleTheme(): void {
    this.setTheme(this.theme === 'dark' ? 'light' : 'dark');
  }
  setView(v: View): void {
    this.view = v;
  }
  toggleCmdk(): void {
    this.cmdkOpen = !this.cmdkOpen;
  }
  dispose(): void {
    // Through `#closeSocket`, so the pending reconnect goes with it. Closing the socket alone
    // would leave a timer that reopens one after the component that owned it is gone.
    this.#closeSocket();
    this.connected = false;
  }

  /**
   * Try again after a failure the operator can see.
   *
   * Errors were dead ends: a banner with no retry and no dismiss, so the only way past one was to
   * reload. This is the retry; `dismissError` is the other half.
   */
  async retry(): Promise<void> {
    this.error = null;
    await this.refresh();
    if (this.boardId && !this.connected) this.#connect(this.boardId);
  }

  dismissError(): void {
    this.error = null;
  }
}

export const app = new AppStore();
