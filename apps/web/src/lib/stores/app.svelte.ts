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
  setUnauthorizedHandler,
  type BoardFeedEvent,
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
  getMembers,
  type Member,
  listLabels,
  type Label,
  listProjects,
  type Project,
} from '$lib/api';
import { passesArchivedFilter, passesProjectFilter } from './card-filters';
import { feedIsStalled, STALL_CHECK_MS } from '../feed-liveness';

const BOARD_KEY = 'superpipeline.boardId';
const THEME_KEY = 'superpipeline.theme';

export type Theme = 'dark' | 'light';
export type View = 'board' | 'list' | 'projects';
export type ListGroupBy = 'stage' | 'state' | 'owner' | 'priority';
export interface CardFilters {
  states: string[];
  owners: string[];
  minPriority: number | null;
  needsReview: boolean;
  live: boolean;
  overBudget: boolean;
  /** A card matches only when it carries EVERY selected label — narrowing is what a filter is for. */
  labels: string[];
  /** Archived cards are hidden by default; this is the one way back in. */
  showArchived: boolean;
  /** A card matches only when its `projectId` is exactly this one (Task 20, Step 3). `null` = off. */
  projectId: string | null;
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
  /**
   * The workspace's people, held for the same reason the agents are: so an id can be shown as a
   * name. A card's owner and a gate's decider are user ids, and printing one at a person is the
   * same complaint as printing an agent id.
   */
  members = $state<Member[]>([]);
  /**
   * The tenant's label catalogue (migration 0010), fetched once per board open rather than per
   * card or per render — a tile only ever needs to look an id up in it.
   */
  labels = $state<Label[]>([]);
  /**
   * The tenant's project catalogue (Task 18's `migration 0013`) — cross-board, fetched once per
   * board open the same way `labels` is, so the project filter and `CardDrawer`'s picker only ever
   * need to look an id up in it rather than fetch per card.
   */
  projects = $state<Project[]>([]);

  // navigation + view
  theme = $state<Theme>('dark');
  view = $state<View>('board');
  listGroupBy = $state<ListGroupBy>('stage');
  filters = $state<CardFilters>({
    states: [],
    owners: [],
    minPriority: null,
    needsReview: false,
    live: false,
    overBudget: false,
    labels: [],
    showArchived: false,
    projectId: null,
  });

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
  #feedListeners = new Set<(event: BoardFeedEvent) => void>();
  #socketGeneration = 0;
  /**
   * When the socket last delivered anything, and the watchdog that reads it.
   *
   * `connected` was set true on `open` and false on `close`, and a socket that stops DELIVERING
   * without closing fires neither. Measured on a live card: the API went 311 → 318 activities over 45
   * seconds while the open panel sat at 298 and never caught up — `connected` still true, no
   * "offline", no reconnect, and a reload fixed it. An idle proxy dropping the connection or a Worker
   * rotating underneath does not necessarily produce a `close` the page sees, so liveness has to be
   * OBSERVED rather than trusted (`feed-liveness.ts`).
   */
  #lastMessageAt: number | null = null;
  #stallTimer: ReturnType<typeof setInterval> | undefined;

  // ---- derived reads (methods stay reactive when read in templates) ----
  boardStates(): string[] {
    return this.board ? [...new Set(this.board.cards.map((c) => c.state))].sort() : [];
  }
  boardOwners(): string[] {
    return this.board ? [...new Set(this.board.cards.map((c) => c.ownerUserId))].sort() : [];
  }
  /** id → {name, colour}, for a tile or filter that only knows a card's label ids. */
  labelById(): Map<string, { name: string; colour: string }> {
    return new Map(this.labels.map((l) => [l.id, { name: l.name, colour: l.colour }]));
  }
  /** id → Project, for a filter chip or a card's assignment that only knows the id. */
  projectById(): Map<string, Project> {
    return new Map(this.projects.map((p) => [p.id, p]));
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
      if (!passesArchivedFilter(f.showArchived, c.archivedAt)) return false;
      if (f.labels.length > 0 && !f.labels.every((l) => c.labels.includes(l))) return false;
      if (!passesProjectFilter(f.projectId, c.projectId)) return false;
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
    /**
     * A 401 anywhere means the session this tab is holding is gone, whatever it decided at boot.
     *
     * Without this the app decides `authState` once and never revisits it, so an expired session
     * presents as a board that stopped updating and buttons that do nothing — the failure is
     * total and says nothing, which is the worst shape a failure can have. The socket is closed
     * too: reconnecting a dead session forever would keep the board looking merely offline.
     */
    setUnauthorizedHandler(() => {
      if (this.authState === 'signed-out') return;
      this.authState = 'signed-out';
      this.user = null;
      this.#closeSocket();
    });
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
    // Best-effort and independent: a workspace where one read is refused should still resolve the
    // others rather than fall back to ids for everything.
    const [agents, members, labels, projects] = await Promise.allSettled([
      getAgents(),
      getMembers(),
      listLabels(),
      listProjects(),
    ]);
    this.agents = agents.status === 'fulfilled' ? agents.value : [];
    this.members = members.status === 'fulfilled' ? members.value : [];
    this.labels = labels.status === 'fulfilled' ? labels.value : [];
    this.projects = projects.status === 'fulfilled' ? projects.value : [];
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
    const sock = openBoardSocket(boardId, (event) => {
      this.#lastMessageAt = Date.now();
      void this.refresh();
      // Fan the event out to whoever is watching one card. The board snapshot that `refresh`
      // reloads does not carry activities, so without this the open card learns nothing.
      if (event) for (const fn of this.#feedListeners) fn(event);
    });
    sock.addEventListener('open', () => {
      if (generation !== this.#socketGeneration) return;
      this.connected = true;
      this.#reconnectAttempt = 0;
      // Null, not now(): there is nothing to measure until the first event, and starting the clock
      // here would make a slow first message look like a stall.
      this.#lastMessageAt = null;
      this.#watchForStall(boardId, generation);
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

  /**
   * Subscribers to the live feed, for things the board snapshot does not carry.
   *
   * The card drawer is the reason this exists: its activity list is a separate fetch, and it used
   * to refresh only when the open card CHANGED — so a run could post sixty-seven activities, every
   * one of them arriving on this socket, and the panel a person was watching showed none of them
   * until the card moved stage and remounted the drawer.
   *
   * Returns its own unsubscribe. A `Set` rather than a single callback because two components may
   * legitimately watch at once, and a second one silently replacing the first is the kind of bug
   * that only shows up when someone opens two panels.
   */
  onFeed(fn: (event: BoardFeedEvent) => void): () => void {
    this.#feedListeners.add(fn);
    return () => this.#feedListeners.delete(fn);
  }

  /**
   * Notice a feed that has stopped carrying anything, and treat it as the disconnection it is.
   *
   * Only ever acts while a card is `working`: a board with nothing running is legitimately silent for
   * hours, and reconnecting every viewer of every quiet board on a timer is a thundering herd this
   * class already jitters its backoff to avoid.
   *
   * It reconnects through the same path a `close` does — flip `connected` false so the UI stops
   * claiming to be live, then re-open — because the failure is indistinguishable from a close that
   * never fired, and inventing a second recovery route would mean two things to keep in step.
   */
  #watchForStall(boardId: string, generation: number): void {
    if (this.#stallTimer !== undefined) clearInterval(this.#stallTimer);
    this.#stallTimer = setInterval(() => {
      if (generation !== this.#socketGeneration) return;
      const working = (this.board?.cards ?? []).some((c) => c.state === 'working');
      if (!feedIsStalled({ now: Date.now(), lastMessageAt: this.#lastMessageAt, hasWorkInFlight: working })) {
        return;
      }
      this.connected = false;
      this.#connect(boardId);
    }, STALL_CHECK_MS);
  }

  /** Close the socket and cancel any pending reconnect, invalidating both for good measure. */
  #closeSocket(): void {
    this.#socketGeneration += 1;
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    if (this.#stallTimer !== undefined) clearInterval(this.#stallTimer);
    this.#stallTimer = undefined;
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
    // Best-effort, same as openBoard: the label catalogue used to load ONLY there, so a label
    // created (or renamed) after board load never updated `app.labels` — the drawer's editor then
    // resolved a stale catalogue against a fresher card and could silently wipe labels off a card
    // it could no longer see (finding 2, phase-1 fix wave). `refresh()` runs after every save
    // (including the one that just created a label) and on every live-feed event, so this keeps
    // the catalogue as current as the board itself. A failed reload here must not fail the whole
    // refresh — `resolveCardLabelsForEdit`'s `blind` guard is what protects a save when the
    // catalogue genuinely cannot be trusted.
    try {
      this.labels = await listLabels();
    } catch {
      /* stale catalogue is recoverable; failing refresh entirely is not */
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
      // The due date is `dueAt`, a first-class field on `createCard` — never `spec.due`. Two
      // sources of truth for one date is the condition the `due_at` column exists to end.
      await createCard(this.boardId, title.trim(), {
        priority: detail?.priority,
        spec: Object.keys(spec).length > 0 ? spec : undefined,
        dueAt: detail?.due && detail.due.trim() !== '' ? detail.due.trim() : undefined,
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
