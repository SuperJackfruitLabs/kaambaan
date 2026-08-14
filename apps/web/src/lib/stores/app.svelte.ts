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
  agents = $state<Array<{ id: string; name: string; capabilities: string[] }>>([]);

  // navigation + view
  screen = $state<Screen>('board');
  theme = $state<Theme>('dark');
  view = $state<View>('board');
  listGroupBy = $state<ListGroupBy>('stage');
  filters = $state<CardFilters>({ states: [], owners: [], minPriority: null, needsReview: false, live: false, overBudget: false });

  // overlays
  openCardId = $state<string | null>(null);
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
  async init(): Promise<void> {
    this.initTheme();
    try {
      this.user = await getMe();
      if (!this.user) {
        this.authState = 'signed-out';
        return;
      }
      this.authState = 'ready';
      let id = localStorage.getItem(BOARD_KEY);
      if (id) {
        try {
          await getBoard(id);
        } catch {
          id = null;
          localStorage.removeItem(BOARD_KEY);
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
