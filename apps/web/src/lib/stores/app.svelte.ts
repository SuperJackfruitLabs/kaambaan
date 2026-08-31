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

export type Screen = 'board' | 'triage' | 'telemetry';
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
  error = $state<string | null>(null);

  // collaboration data
  notifications = $state<Notification[]>([]);
  agents = $state<AgentSummary[]>([]);

  // navigation + view
  screen = $state<Screen>('board');
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
  railOpen = $state(false);
  cmdkOpen = $state(false);

  #socket: WebSocket | undefined;

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
    this.#socket?.close();
    const sock = openBoardSocket(id, () => this.refresh());
    sock.addEventListener('open', () => (this.connected = true));
    sock.addEventListener('close', () => (this.connected = false));
    this.#socket = sock;
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

  async dispatchCard(title: string): Promise<void> {
    if (!this.boardId || title.trim() === '') return;
    try {
      await createCard(this.boardId, title.trim());
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

  async createFirstBoard(): Promise<void> {
    try {
      await this.openBoard(await createBoard('My first board', BOARD_TEMPLATES[0]!.stages));
    } catch (e) {
      this.error = String(e);
    }
  }

  openCard(id: string): void {
    this.openCardId = id;
  }
  closeCard(): void {
    this.openCardId = null;
  }
  setScreen(s: Screen): void {
    this.screen = s;
    // A nav rail that stays open over the thing you just navigated to is the
    // most common version of this bug, so choosing a screen closes it.
    this.railOpen = false;
  }

  toggleRail(): void {
    this.railOpen = !this.railOpen;
  }

  closeRail(): void {
    this.railOpen = false;
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
    this.#socket?.close();
  }
}

export const app = new AppStore();
