import type { AgentScope } from '@superpipeline/contract';
/**
 * Thin client for the Superpipeline API (apps/api). The deployed app authenticates with a session cookie
 * (sent automatically, same-origin); the `X-Tenant-Id` header is a no-op there and only enables the
 * local dev workspace (when the server runs with DEV_AUTH on).
 */
import { hubToken, withAuthority } from './hub-token';

const TENANT = 'tnt_dev';

/**
 * What to do when the server says the session is gone.
 *
 * `authState` is decided once, at `init()`, and never revisited — so a session that expires while
 * a tab is open leaves the app certain it is signed in while every request 401s. What a person
 * sees then is a board that has stopped updating and buttons that do nothing, with no statement
 * anywhere that they are signed out. A gate rejected from another client, a card that will not
 * move, a live feed that never reconnects: all the same silence.
 *
 * Registered by the store, called from the reads that run on a timer and the writes a person
 * clicks — enough that an expired session is noticed within one refresh rather than never.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

/** Pass every response through this. Returns it untouched, so it can wrap a call in place. */
export function noteAuth(res: Response): Response {
  if (res.status === 401) onUnauthorized?.();
  return res;
}
const headers = { 'X-Tenant-Id': TENANT, 'Content-Type': 'application/json' };

export interface User {
  userId: string;
  tenantId: string;
  name?: string;
  login?: string;
  avatarUrl?: string;
}

export interface BoardSummary {
  id: string;
  name: string;
}

export interface AgentToken {
  agent: { id: string; name: string; capabilities: string[] };
  token: string;
  tokenId: string;
}

/** One agent as the console sees it — including whether it's linked to a suite principal, and what it can still authenticate with. */
export interface AgentSummary {
  id: string;
  name: string;
  capabilities: string[];
  /** Its mapped suite principal (`prn_…`), or null — the normal state for a standalone board. */
  externalId: string | null;
  externalSource: string | null;
  /** An avatar for card tiles, or null — the tile falls back to a coloured initial. */
  iconUrl: string | null;
  /** How many cards this agent may hold at once. */
  concurrency: number;
  /**
   * Active (non-revoked) token ids. Empty means this agent cannot authenticate with a `spa_`
   * token right now — which for a linked agent is the ordinary state, since it authenticates
   * with hub-issued tokens instead.
   */
  tokenIds: string[];
}

export interface Stage {
  /** The stage's standing rule, handed to every agent that claims a card here. */
  instructions?: string;
  key: string;
  name: string;
  order: number;
  gate?: 'none' | 'approval';
  wipLimit?: number;
  routing?: 'pipeline' | 'manager';
  ownerKind?: 'capability' | 'human';
  owner?: string;
  /**
   * A multi-capability requirement: `all` every member, `any` at least one. Wins over `owner`
   * when present. A sibling of `owner` rather than a widening of it, so a board written before
   * this existed reads back unchanged.
   */
  requires?: { all?: string[]; any?: string[] };
}

export interface Card {
  id: string;
  title: string;
  spec?: Record<string, unknown> | null;
  ownerUserId: string;
  currentStageKey: string;
  state: string;
  priority: number;
  costUsd: number;
  overBudget: boolean;
  attemptCount: number;
  delegateAgentId?: string | null;
  /**
   * Who authorised this card's dispatch — the third of a card's three identities, and the one this
   * client never declared.
   *
   * It has been on the wire since the control pair shipped and is deliberately preserved when
   * ownership is reassigned, which means the API has always distinguished "who is answerable" from
   * "who asked" while the board showed only the first. Null on a card created before it was
   * recorded.
   */
  queuedBy: string | null;
  /**
   * The AGENT that queued it, when one did — `agt_…`, not a principal. Null means a person did,
   * which is every card that existed before agents could queue work.
   */
  queuedByAgentId: string | null;
  /**
   * What the queuer was permitted to dispatch when they queued it. Null is "no authority was
   * captured"; `[]` is "somebody decided nobody" — both refuse a claim under enforcement, and they
   * are different facts about why.
   */
  queuedGrant: string[] | null;
  /** Applied label ids; the catalogue itself is fetched separately (`listLabels`). */
  labels: string[];
  dueAt: string | null;
  archivedAt: string | null;
  /**
   * This card's `parent` edge (`card_links`, this card as `to_card_id`), or null if it has none.
   * Task 14; type-only addition here (Task 17b) — already on the wire via `CardView`, just never
   * declared on this client type until the sub-tasks UI needed to count siblings by it.
   */
  parentCardId: string | null;
  /**
   * How many of this card's direct children are still unresolved — the same rule
   * `blockedWhere`/`openChildCount` enforce at claim time (Task 14). A DIFFERENT fact from
   * `blockedBy`: an open child parks the PARENT (it cannot advance), it does not block anything
   * from being claimed, so it gets its own counter rather than sharing the `⛔` badge.
   */
  openChildCount: number;
  /**
   * `costUsd` plus one level of children's summed cost (Task 14). Deliberately separate from
   * `costUsd`, which still means "what this card itself spent" for `overBudget`.
   */
  costUsdRollup: number;
  /**
   * Unresolved same-board `blocks` edges holding this card back — the enforced kind, derived
   * server-side from the same predicate the claim query uses (`CardView.blockedBy`, Task 17c).
   * Empty when nothing blocks the card, including when it only has an open child (that is
   * `openChildCount`'s fact, not this one) or only cross-board advisory blockers (Task 16, not
   * enforced, carried separately by the links route).
   */
  blockedBy: Array<{ cardId: string; title: string }>;
  /**
   * Cross-board project/milestone membership (Task 19, `CardView.projectId`/`milestoneId`) —
   * already on the wire since the DO started stamping it; never declared on this client type
   * until Step 3's project filter and milestone picker needed to read it.
   *
   * An unresolved id is a normal state, not an error: `DELETE /v1/projects/:id` deletes
   * unconditionally (`db/projects.ts`), and a card sitting in a board Durable Object has no way
   * to be told its project just vanished. Treat it exactly like a stale label id — droppable,
   * never a reason to assume `listProjects()`/`getProject()` can resolve it.
   */
  projectId: string | null;
  milestoneId: string | null;
}

/** One entry in the tenant's label catalogue (migration 0010). */
export interface Label {
  id: string;
  tenantId: string;
  name: string;
  colour: string;
  /**
   * How this label came to exist — `declared, inferred`, the same spelling and the same
   * distinction `CapabilityRecord.origin` already carries (`apps/api/src/db/capabilities.ts`'s
   * `CapabilityOrigin`). `inferred` means it was typed into a card's Labels field and registered
   * on the spot (`resolveLabelNames`, `apps/api/src/db/labels.ts`); `declared` means someone named
   * it deliberately. Typed as the union the server actually stores, not `string`, so a third value
   * nobody meant to introduce is a compile error here rather than a silently rendered one.
   */
  origin: 'declared' | 'inferred';
  createdAt: string;
}

export interface Attempt {
  runId: string;
  agentId: string;
  stageKey: string;
  status: string;
  outcome: string | null;
  costUsd: number;
  model: string | null;
  profileKey: string | null;
  /**
   * What THIS run handed on, kept per-run since the spec of 2026-10-02.
   *
   * The card's `handoff` is one value overwritten at every stage, so it only ever showed the latest.
   * This is what lets a reader see the account stage by stage rather than its last line.
   */
  handoff: unknown;
  /** Why this run died. Null for one that completed, or is still open. */
  failureReason: string | null;
}

export interface Activity {
  seq: number;
  runId: string;
  type: string;
  ts: string;
  body: string | null;
  action: string | null;
  parameter: unknown;
  result: unknown;
  signal: string | null;
}

export interface BoardEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  ts: string;
}

/**
 * The board's own log.
 *
 * `BoardDO.getEvents` has existed since the DO did and had no route: every state change was
 * appended to `events` and there was no way to read them back, so the only audit trail the
 * product keeps was unreachable.
 */
export async function getBoardEvents(boardId: string, limit = 100): Promise<BoardEvent[]> {
  const res = await fetch(`/v1/boards/${boardId}/events?limit=${limit}`, { headers });
  if (!res.ok) throw new Error(`getBoardEvents failed (${res.status})`);
  return ((await res.json()) as { events: BoardEvent[] }).events;
}

export interface CardActivities {
  activities: Activity[];
  handoff: Record<string, unknown> | null;
  /** Every gate on this card, decided ones included — the card's approval history. */
  gates: Gate[];
}

export interface Notification {
  seq: number;
  kind: string;
  cardId: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export interface BoardUsage {
  totalCostUsd: number;
  estimatedCostUsd: number;
  budgetUsd: number | null;
  cardUsdCap: number | null;
  overBudget: boolean;
}

/** Cost rollup from `GET /v1/boards/:id/usage` (docs/07 §6) — totals plus by-model/agent/card. */
export interface UsageSummary {
  totalCostUsd: number;
  estimatedCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  unpricedRecords: number;
  byModel: Array<{ model: string; costUsd: number; inputTokens: number; outputTokens: number }>;
  byAgent: Array<{ agentId: string; costUsd: number }>;
  byCard: Array<{ cardId: string; costUsd: number }>;
}

export interface GateOption {
  name: string;
  title: string;
  interactive?: boolean;
}

export interface Gate {
  id: string;
  cardId: string;
  stageKey: string;
  status: string;
  options: GateOption[];
  producedBy: string;
  decision?: string | null;
  /**
   * Who decided, and what they said. Both columns were written on every resolution and appeared
   * in no read shape at all — so who approved what, and the feedback they gave with it, was
   * recorded and unreadable. Null while the gate is pending.
   */
  decidedBy?: string | null;
  comment?: string | null;
  resolvedAt?: string | null;
}

export type GateDecision = 'approve' | 'request_changes' | 'reject';

/**
 * A question an agent stopped to ask (docs/04 §4). The card waits in `input-required` while the
 * agent holds its lease; answering it here is what lets the agent carry on.
 */
export interface Elicitation {
  id: string;
  cardId: string;
  runId: string;
  stageKey: string;
  agentId: string;
  question: string;
  signal: string | null;
  options: GateOption[];
  status: 'pending' | 'answered' | 'cancelled';
  answer: { option: string | null; text: string | null; answeredBy: string; answeredAt: string } | null;
  createdAt: string;
}

export interface Reference {
  id: string;
  cardId: string;
  /**
   * The run that attached this, when an agent did it mid-run. Null for a human's, and for every
   * reference from before the column existed — both of which belong to the card rather than to a
   * stage.
   */
  runId?: string | null;
  url: string;
  title?: string | null;
  subtitle?: string | null;
  provider: string;
  sourceType: string;
  externalId?: string | null;
  metadata?: Record<string, unknown> | null;
  addedBy: 'agent' | 'user';
}

export interface BoardSnapshot {
  boardId: string | null;
  tenantId: string | null;
  name: string | null;
  stages: Stage[];
  cards: Card[];
  gates: Gate[];
  elicitations: Elicitation[];
  references: Reference[];
  usage: BoardUsage;
  github: {
    issueTrigger: boolean;
    webhookConfigured: boolean;
    /**
     * How many principals the board's standing trigger grant names, or null when it has none.
     * Null with `issueTrigger` on means every card the integration creates will be refused at
     * claim time — which is worth saying out loud, because nothing else notices.
     */
    triggerGrantCount: number | null;
  };
}

export interface Profile {
  key: string;
  name: string | null;
  harness: string | null;
  model: string | null;
  permissionPolicy: string | null;
  autonomyLevel: string | null;
  capabilities: string[];
}

/**
 * Starting pipelines, and the lanes a board gets when no template is chosen.
 *
 * **Defined in `@superpipeline/contract` since 2026-09-20**, not here. `supi` creates boards too
 * now, and two copies of a template list drift in the way that is hardest to notice: both
 * clients keep working, each making a different board. Re-exported rather than merely imported
 * so every existing `from '$lib/api'` keeps resolving.
 */
export { DEFAULT_STAGES, BOARD_TEMPLATES, boardTemplate } from '@superpipeline/contract';
export type { BoardTemplate, BoardTemplateStage } from '@superpipeline/contract';

/** The scope vocabulary a mint may narrow to. See `issueAgentToken`. */
export { AGENT_TOKEN_SCOPES, type AgentScope } from '@superpipeline/contract';

/**
 * A recurring card, and the cadence that fires it (Task 8/9's `ScheduleView`, routed by Task 10).
 *
 * `timezone` is stored and echoed back exactly as the operator typed it — never the runtime's
 * `resolvedOptions().timeZone`, which ICU can canonicalise to a different spelling of the same
 * zone (`Asia/Kolkata` → `Asia/Calcutta`). `skipCount` is the signal that this schedule is
 * fighting an open card: the previous instance was still open when the next fire came due.
 */
export interface Schedule {
  id: string;
  enabled: boolean;
  title: string;
  spec: Record<string, unknown> | null;
  priority: number;
  labels: string[];
  stageKey: string | null;
  rule: string;
  timezone: string;
  overlap: 'skip' | 'allow';
  nextFireAt: string;
  lastFiredAt: string | null;
  lastCardId: string | null;
  skipCount: number;
  /** Who declared this schedule, and who every card it mints is owned by. */
  createdBy: string | null;
}

/** A board's schedules. Answers an empty list rather than throwing when the read is refused. */
export async function getSchedules(boardId: string): Promise<Schedule[]> {
  const res = await fetch(`/v1/boards/${boardId}/schedules`, { headers });
  if (!res.ok) return [];
  return ((await res.json()) as { schedules: Schedule[] }).schedules;
}

/**
 * Declare a schedule. Returns the raw response so the caller can show the parser's own message —
 * "the shortest interval is 5 minutes" is the sentence that tells the author what to type instead,
 * and a generic failure would hide it.
 */
export function createSchedule(
  boardId: string,
  input: {
    title: string;
    rule: string;
    timezone: string;
    overlap?: 'skip' | 'allow';
    stageKey?: string | null;
    priority?: number;
    labels?: string[];
    spec?: Record<string, unknown>;
  },
): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/schedules`, { method: 'POST', headers, body: JSON.stringify(input) });
}

/** Edit a schedule, or pause/resume it with `{ enabled }`. */
export function updateSchedule(
  boardId: string,
  scheduleId: string,
  patch: Partial<{
    title: string;
    rule: string;
    timezone: string;
    overlap: 'skip' | 'allow';
    stageKey: string | null;
    priority: number;
    labels: string[];
    spec: Record<string, unknown>;
    enabled: boolean;
  }>,
): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/schedules/${scheduleId}`, { method: 'PATCH', headers, body: JSON.stringify(patch) });
}

export function deleteSchedule(boardId: string, scheduleId: string): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/schedules/${scheduleId}`, { method: 'DELETE', headers });
}

export async function createBoard(name: string, stages: Stage[]): Promise<string> {
  const res = await fetch('/v1/boards', { method: 'POST', headers, body: JSON.stringify({ name, stages }) });
  if (!res.ok) throw new Error(`createBoard failed (${res.status})`);
  const data = (await res.json()) as { boardId: string };
  return data.boardId;
}

export async function getBoard(boardId: string): Promise<BoardSnapshot> {
  const res = noteAuth(await fetch(`/v1/boards/${boardId}`, { headers }));
  if (!res.ok) throw new Error(`getBoard failed (${res.status})`);
  return (await res.json()) as BoardSnapshot;
}

/**
 * Creating a card in the first stage IS queueing it — it is claimable the moment
 * it exists — so this carries the operator's authority, and the server records
 * what it permits against the card. Without it the card is queued by nobody with
 * permission, and under enforcement no agent may run it.
 */
export async function createCard(
  boardId: string,
  title: string,
  detail?: { priority?: number; spec?: Record<string, unknown>; dueAt?: string },
): Promise<void> {
  const res = await fetch(`/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: await withAuthority(headers),
    // Owner is the signed-in user, set by the server. Priority, spec and dueAt are sent only when
    // given, so a one-line dispatch produces exactly the request it always did.
    body: JSON.stringify({
      title,
      ...(detail?.priority !== undefined ? { priority: detail.priority } : {}),
      ...(detail?.spec ? { spec: detail.spec } : {}),
      ...(detail?.dueAt !== undefined ? { dueAt: detail.dueAt } : {}),
    }),
  });
  if (!res.ok) throw new Error(`createCard failed (${res.status})`);
}

/**
 * Split a card into children, one per (non-blank) title (Task 15's `POST …/cards/:cardId/split`,
 * unwired to any web client until now). "Add sub-task" (Task 17b) calls this with a single title
 * rather than `createCard` + `addLink('parent')`: `createCard`'s wrapper above discards its
 * response body, so it has no way to hand back the new card's id to link as a child, while this
 * route's response already carries the created children in full — one call, no race.
 *
 * Returns the raw response, like `addLink`/`removeLink` do, so a caller can surface the server's
 * own refusal (`TOO_MANY_CHILDREN`, `NOTHING_TO_SPLIT`, `CARD_BLOCKED`) as a sentence.
 */
export function splitCard(boardId: string, cardId: string, titles: string[]): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/cards/${cardId}/split`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ titles }),
  });
}

/**
 * Edit a card's title / description (spec) / priority / owner.
 *
 * `ownerUserId` reassigns. It is deliberately not `queuedBy`: who is answerable for a card and
 * who authorised its dispatch are different questions, and only the second is checked at claim.
 */
export function updateCard(
  boardId: string,
  cardId: string,
  patch: {
    title?: string;
    spec?: Record<string, unknown>;
    priority?: number;
    ownerUserId?: string;
    labels?: string[];
    /**
     * The comma-separated names `CardDrawer`'s Labels input parses — resolved to catalogue ids
     * server-side (`resolveLabelNames`), which creates a name that does not exist yet rather than
     * refusing it. Sent instead of `labels`, never alongside it.
     */
    labelNames?: string[];
    dueAt?: string | null;
    archivedAt?: string | null;
    /**
     * Cross-board project/milestone membership (migration 0013; Task 19). `null` clears it. The
     * route validates both — an unknown `projectId` is left alone (a normal state, see
     * `Card.projectId`'s comment), but a `milestoneId` that does not belong to the EFFECTIVE
     * project (after this same patch) is refused as `MILESTONE_NOT_IN_PROJECT`. `CardDrawer`'s
     * picker (`milestone-picker.ts`'s `assignmentPatch`) is written to never send a mismatch, by
     * clearing the milestone the moment the project changes — not by relying on this route to
     * catch it after the fact.
     */
    projectId?: string | null;
    milestoneId?: string | null;
  },
): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/cards/${cardId}`, { method: 'PATCH', headers, body: JSON.stringify(patch) });
}

/**
 * Rework a board's pipeline.
 *
 * The whole list, not a patch: order is a property of the list rather than of any stage in it, so
 * a partial update cannot express a reorder. Returns the raw response so a caller can show the
 * server's own refusal — "stage \"todo\" still holds 3 cards" is the useful sentence, and a
 * generic failure would hide the one fact the operator needs.
 */
export function setStages(boardId: string, stages: Stage[]): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/stages`, { method: 'PUT', headers, body: JSON.stringify({ stages }) });
}

/**
 * Change ONE stage.
 *
 * `setStages` replaces the whole pipeline, so editing one field means sending every other stage
 * back exactly as it was read — and any edit made in between, by a person or by the board itself,
 * is overwritten by a form that never knew about it. `key` and `order` are not patchable; the
 * route refuses them by name, because reordering is a statement about the pipeline as a whole.
 */
export function patchStage(
  boardId: string,
  stageKey: string,
  patch: Partial<Pick<Stage, 'name' | 'owner' | 'ownerKind' | 'gate' | 'wipLimit'>> & {
    instructions?: string | null;
    requires?: Stage['requires'] | null;
  },
): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/stages/${encodeURIComponent(stageKey)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  });
}

/** Delete a card and everything scoped to it. */
export function deleteCard(boardId: string, cardId: string): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/cards/${cardId}`, { method: 'DELETE', headers });
}

/**
 * Archive a card: `PATCH archivedAt` with a real timestamp, not a client-side flag. Phase 1
 * shipped an `archivedAt` column and a "show archived" filter with no way to ever produce an
 * archived card — a filter for a state nothing could reach. This is that write.
 */
export function archiveCard(boardId: string, cardId: string): Promise<Response> {
  return updateCard(boardId, cardId, { archivedAt: new Date().toISOString() });
}

/**
 * Un-archive a card: `PATCH archivedAt` to `null`. Whole-branch review, Minor: `board-do.ts:3347`
 * names un-archiving as one of three recoveries for a parent parked by an archived child — the
 * other two already had a surface, this one didn't, making an archived card a one-way door through
 * the web app even though the route/DO have always accepted `archivedAt: null`.
 */
export function unarchiveCard(boardId: string, cardId: string): Promise<Response> {
  return updateCard(boardId, cardId, { archivedAt: null });
}

/** Dependencies and sub-task containment (spec §3.4) — one table on the DO, told apart by `kind`. */
export type LinkKind = 'blocks' | 'relates' | 'parent';

/**
 * A same-board edge (Task 12's `card_links`, read on the claim path). NOT always enforced: the
 * route stamps `enforced: kind !== 'relates'` (whole-branch review fix, commit `166abfe`) — a
 * `relates` edge is decoration, consulted nowhere `blockedWhere` looks, so it reads `false` here
 * exactly like a cross-board `ExternalLink` does, even though it lives in the same-board store.
 */
export interface Link {
  fromCardId: string;
  toCardId: string;
  kind: LinkKind;
  createdAt: string;
  createdBy: string | null;
  enforced: boolean;
}

/**
 * A cross-board edge (Task 16's `card_links_external`) — advisory, always. `parent` is not a valid
 * kind here: a parent edge carries a rule (a parent does not advance while a child is open), and
 * an edge nothing enforces cannot carry one.
 */
export interface ExternalLink {
  fromBoardId: string;
  fromCardId: string;
  toBoardId: string;
  toCardId: string;
  kind: 'blocks' | 'relates';
  enforced: false;
  /**
   * The OTHER end's card title (whichever end is not the card `listLinks` was asked about),
   * resolved server-side, per row, by `GET .../links` itself (17b follow-up, commit `433f4bb`) —
   * never re-derived or re-fetched on the client. `null` is a real state, not a missing field: the
   * other board may be unavailable, the card may be gone, or it may belong to another tenant, and
   * the route degrades that one row rather than failing the whole response.
   */
  otherCardTitle: string | null;
  /** The OTHER end's board name, resolved the same way and with the same `null` meaning. */
  otherBoardName: string | null;
}

export interface CardLinks {
  links: Link[];
  externalLinks: ExternalLink[];
}

/**
 * Declare an edge between two cards. Returns the raw response, like `setStages` does, so a caller
 * can show the server's own refusal sentence — `LINK_WOULD_CYCLE` and `ALREADY_HAS_PARENT` each
 * say which cards are involved, and "invalid link" would throw that away.
 *
 * `toBoardId` names where `toCardId` lives when it is on another board. Omitted, the edge stays
 * same-board and enforced (Task 12's DO). Given a board other than `boardId`, the SAME route
 * (Task 17d) stores it in Task 16's advisory D1 table instead and the response says
 * `enforced: false` — the server decides the store from this value, never the client.
 */
export function addLink(boardId: string, fromCardId: string, toCardId: string, kind: LinkKind, toBoardId?: string): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/links`, {
    method: 'POST',
    headers,
    body: JSON.stringify(toBoardId ? { fromCardId, toCardId, kind, toBoardId } : { fromCardId, toCardId, kind }),
  });
}

/**
 * Remove an edge. Removing one that is not there is not an error — same as the route it calls.
 * `toBoardId`, as in `addLink`, routes the removal to the advisory D1 store when it names another
 * board.
 */
export function removeLink(boardId: string, fromCardId: string, toCardId: string, kind: LinkKind, toBoardId?: string): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/links`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify(toBoardId ? { fromCardId, toCardId, kind, toBoardId } : { fromCardId, toCardId, kind }),
  });
}

/** Every edge touching this card: same-board (enforced) and cross-board (advisory), kept apart. */
export async function listLinks(boardId: string, cardId: string): Promise<CardLinks> {
  const res = await fetch(`/v1/boards/${boardId}/cards/${cardId}/links`, { headers });
  if (!res.ok) return { links: [], externalLinks: [] };
  return (await res.json()) as CardLinks;
}

/** Attach a reference (link) to a card by hand. */
export function addReference(boardId: string, cardId: string, ref: { url: string; title?: string }): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/cards/${cardId}/references`, { method: 'PUT', headers, body: JSON.stringify({ ...ref, addedBy: 'user' }) });
}

/**
 * Returns the raw response so callers can surface WIP-limit (409) and
 * unknown-stage (400) cases.
 *
 * Carries authority for the same reason `createCard` does: whoever moves a card
 * into a dispatchable stage is the one dispatching it now, and that need not be
 * the person who created it.
 */
export async function moveCard(boardId: string, cardId: string, toStageKey: string): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/cards/${cardId}/move`, {
    method: 'POST',
    headers: await withAuthority(headers),
    body: JSON.stringify({ toStageKey }),
  });
}

/** The attempts (runs) for a card, for the comparison view (docs/07 §5). */
export async function getAttempts(boardId: string, cardId: string): Promise<Attempt[]> {
  const res = await fetch(`/v1/boards/${boardId}/cards/${cardId}/attempts`, { headers });
  if (!res.ok) throw new Error(`getAttempts failed (${res.status})`);
  return ((await res.json()) as { attempts: Attempt[] }).attempts;
}

/** A card's session-replay timeline + carried handoff (docs/07 §4). */
export async function getCardActivities(boardId: string, cardId: string): Promise<CardActivities> {
  const res = noteAuth(await fetch(`/v1/boards/${boardId}/cards/${cardId}/activities`, { headers }));
  if (!res.ok) throw new Error(`getCardActivities failed (${res.status})`);
  return (await res.json()) as CardActivities;
}

/** In-app notification feed (docs/07 §7). */
export async function getNotifications(boardId: string): Promise<Notification[]> {
  const res = await fetch(`/v1/boards/${boardId}/notifications`, { headers });
  if (!res.ok) throw new Error(`getNotifications failed (${res.status})`);
  return ((await res.json()) as { notifications: Notification[] }).notifications;
}

export function markNotificationRead(boardId: string, seq: number): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/notifications/${seq}/read`, { method: 'POST', headers });
}

/** Resolve an approval gate. The resolver identity is the signed-in user (set by the server). */
export function resolveGate(
  boardId: string,
  gateId: string,
  decision: GateDecision,
  comment?: string,
): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/gates/${gateId}/resolve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ decision, comment }),
  }).then(noteAuth);
}

/**
 * Answer an agent's question. The answerer is the signed-in user (set by the server), which is also
 * how the board refuses an agent answering its own question.
 */
export function answerElicitation(
  boardId: string,
  elicitationId: string,
  answer: { option?: string; text?: string },
): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/elicitations/${elicitationId}/answer`, {
    method: 'POST',
    headers,
    body: JSON.stringify(answer),
  });
}

/** The signed-in user, or null when signed out (drives the auth gate). */
export async function getMe(): Promise<User | null> {
  const res = await fetch('/auth/me', { headers });
  if (!res.ok) return null;
  return ((await res.json()) as { user: User | null }).user;
}

export async function logout(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', headers });
}

/** The boards in the signed-in user's workspace. */
export async function getBoards(): Promise<BoardSummary[]> {
  const res = await fetch('/v1/boards', { headers });
  if (!res.ok) throw new Error(`getBoards failed (${res.status})`);
  return ((await res.json()) as { boards: BoardSummary[] }).boards;
}

/**
 * Register an agent and mint its bearer token (shown once).
 *
 * With `externalId` the agent is created AND linked to that suite principal in
 * the one call, and **no** `spa_` token comes back: a linked agent
 * authenticates with hub JWTs, so minting one would hand over a secret the
 * operator must store and never uses.
 */
export async function createAgent(
  name: string,
  capabilities: string[],
  externalId?: string,
): Promise<AgentToken> {
  const body = externalId ? { name, capabilities, externalId } : { name, capabilities };
  const res = await fetch('/v1/agents', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    // The Worker's message is the useful one — "already linked to a different
    // agent" is what an operator needs to read, not a bare status code.
    const detail = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(detail?.error ?? `createAgent failed (${res.status})`);
  }
  return (await res.json()) as AgentToken;
}

/**
 * An agent this operator may dispatch, as the hub reports it.
 *
 * Three fields, because three is what the endpoint returns. There is no `kind`
 * — everything in the list is an agent — and no `suspendedAt`, because a
 * suspended agent is not in the list at all: the hub filters it, and it has to,
 * since the answer is "what you may use" rather than an inventory of the fleet.
 */
export interface HubPrincipal {
  id: string;
  handle: string;
  displayName: string | null;
}

/**
 * The agents this operator may dispatch, from the hub.
 *
 * **Changed from `GET /api/admin/principals` with `credentials: 'include'`,
 * which could not work from `superpipeline.dev` and never did.** The hub's session
 * cookie is `SameSite=Lax` on another registrable domain, so the browser never
 * attached it; and the hub's admin middleware does not accept a hub-issued
 * token either, so holding one would not have rescued it. `GET
 * /api/fleet/dispatchable` is the endpoint built for this question: a Bearer
 * token, no admin role, and it answers with the agents the token's own
 * `mayDispatch` names rather than every principal in the fleet.
 *
 * **Null is an ordinary result and must stay one** — a standalone superpipeline, an
 * operator who has not connected, an expired token, a hub that is down. The
 * caller shows nothing rather than an error, because a superpipeline with no hub is
 * not a broken superpipeline (migration 0003).
 */
export async function getHubPrincipals(): Promise<HubPrincipal[] | null> {
  // Asked first so a board with no authority makes no cross-origin request at
  // all: with no token there is nothing to send, and the answer is the same.
  const token = await hubToken();
  if (!token) return null;

  const base = import.meta.env.PUBLIC_HUB_URL ?? 'https://hub.agentpod.dev';
  try {
    // No `credentials`. The Bearer is the whole credential, and asking for the
    // hub's cookie would be asking for the thing that cannot travel here.
    const res = await fetch(`${base}/api/fleet/dispatchable`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { agents?: HubPrincipal[] };
    return body.agents ?? [];
  } catch {
    return null;
  }
}

export interface Estimate {
  stageKey: string;
  estimatedUsd: number | null;
  sampleSize: number;
}

/** Set or clear the board / per-card USD budget caps (pass null to clear). */
export function setBudget(boardId: string, caps: { boardUsdCap?: number | null; cardUsdCap?: number | null }): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/budget`, { method: 'PUT', headers, body: JSON.stringify(caps) });
}

/** Pre-run cost estimate for a card's current stage, from history (docs/07 §6). */
export async function getEstimate(boardId: string, cardId: string): Promise<Estimate | null> {
  const res = await fetch(`/v1/boards/${boardId}/cards/${cardId}/estimate`, { headers });
  if (!res.ok) return null;
  return (await res.json()) as Estimate;
}

/**
 * Cost/usage rollup for the telemetry view; `window` filters to a recent span.
 *
 * **Throws on failure rather than returning zeros.** It used to answer a failed fetch with a
 * fully zeroed summary, which made a broken telemetry API indistinguishable from a board that has
 * spent nothing — the one reading an operator would act on. "$0.00" is a claim, and a claim the
 * client cannot support must not be made.
 */
export async function getUsage(boardId: string, window: '5h' | '7d' = '7d'): Promise<UsageSummary> {
  const res = await fetch(`/v1/boards/${boardId}/usage?window=${window}`, { headers });
  if (!res.ok) throw new Error(`getUsage failed (${res.status})`);
  return (await res.json()) as UsageSummary;
}

/** The agents registered in the signed-in user's workspace. */
export async function getAgents(): Promise<AgentSummary[]> {
  const res = await fetch('/v1/agents', { headers });
  if (!res.ok) throw new Error(`getAgents failed (${res.status})`);
  return ((await res.json()) as { agents: AgentSummary[] }).agents;
}

/** Rename a board. */
export function renameBoard(boardId: string, name: string): Promise<Response> {
  return fetch(`/v1/boards/${boardId}`, { method: 'PATCH', headers, body: JSON.stringify({ name }) });
}

/** Remove a board from the workspace. */
export function deleteBoard(boardId: string): Promise<Response> {
  return fetch(`/v1/boards/${boardId}`, { method: 'DELETE', headers });
}

/** Configure the GitHub webhook secret + issue→card trigger for a board. */
export function setGithubConfig(boardId: string, cfg: { secret?: string; issueTrigger?: boolean }): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/github`, { method: 'PUT', headers, body: JSON.stringify(cfg) });
}

/** Agent profiles configured on a board (docs/05 §7). */
export async function getProfiles(boardId: string): Promise<Profile[]> {
  const res = await fetch(`/v1/boards/${boardId}/profiles`, { headers });
  if (!res.ok) throw new Error(`getProfiles failed (${res.status})`);
  return ((await res.json()) as { profiles: Profile[] }).profiles;
}

export function createProfile(boardId: string, input: { key: string; name?: string; model?: string; capabilities?: string[] }): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/profiles`, { method: 'POST', headers, body: JSON.stringify(input) });
}

/** Revoke an agent and all of its tokens. */
export function deleteAgent(agentId: string): Promise<Response> {
  return fetch(`/v1/agents/${agentId}`, { method: 'DELETE', headers });
}

/**
 * Link (or, with `null`, clear) an agent's suite principal id.
 *
 * A console action, same as minting or revoking a token — carries no `withAuthority`, because
 * this changes what a hub token can resolve to, not something the change itself needs authority
 * for. Returns the raw response so the caller can read the server's own refusal (a malformed id,
 * or an agent it doesn't own) instead of a generic failure.
 */
export function setAgentPrincipal(agentId: string, externalId: string | null): Promise<Response> {
  return fetch(`/v1/agents/${agentId}`, { method: 'PATCH', headers, body: JSON.stringify({ externalId }) });
}

/**
 * Change an agent's own properties after it exists.
 *
 * Until the API grew this, `capabilities` was fixed at creation: an agent staffed for the wrong
 * stages could only be deleted and remade, which for a linked agent threw away its principal link
 * too. Deliberately separate from {@link setAgentPrincipal} even though both are a PATCH to the
 * same route — linking an identity and editing a description are different acts, and a caller
 * should not have to think about one to do the other.
 */
export function updateAgent(
  agentId: string,
  patch: { name?: string; capabilities?: string[]; iconUrl?: string | null; concurrency?: number },
): Promise<Response> {
  return fetch(`/v1/agents/${agentId}`, { method: 'PATCH', headers, body: JSON.stringify(patch) });
}

/**
 * Issue a fresh `spa_` token for an agent that already exists.
 *
 * The missing half of revocation: the UI has always said a revoked agent "cannot authenticate
 * until reconnected", and there was no reconnect — tokens were minted only when an agent was
 * created. The plaintext comes back exactly once, as it does on create.
 *
 * `scopes` narrows it. A `run`-only credential can drive the card it already holds and cannot
 * claim another — which is what makes it safe to hand to a harness, where the agent itself
 * spends it through MCP. Narrowing is a human act here by design: an agent cannot mint for
 * itself at all, so it can neither narrow nor widen what it was given.
 */
export async function issueAgentToken(
  agentId: string,
  scopes?: AgentScope[],
): Promise<{ token: string; tokenId: string; scopes?: AgentScope[] }> {
  const res = await fetch(`/v1/agents/${agentId}/tokens`, {
    method: 'POST',
    headers,
    // Absent means the full set, which is what every existing caller sends.
    ...(scopes ? { body: JSON.stringify({ scopes }) } : {}),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `issueAgentToken failed (${res.status})`);
  }
  return (await res.json()) as { token: string; tokenId: string; scopes?: AgentScope[] };
}

/**
 * Who is in this workspace, and what they may do.
 *
 * `memberships.role` was CHECK-constrained, written once as 'owner' and read by zero queries, so
 * a workspace was permanently one person. These are the calls that make it a real model.
 */
export type Role = 'viewer' | 'member' | 'admin' | 'owner';

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  createdAt: string;
}

/** Everyone in the workspace, oldest membership first — the founding owner at the top. */
export async function getMembers(): Promise<Member[]> {
  const res = await fetch('/v1/members', { headers });
  if (!res.ok) return [];
  return ((await res.json()) as { members: Member[] }).members;
}

/**
 * Add someone by email. No mail is sent: `users` is keyed on the address GitHub gives at sign-in,
 * so recording the membership first means the invitee signs in and finds the workspace waiting.
 */
export function addMember(email: string, role: Role): Promise<Response> {
  return fetch('/v1/members', { method: 'POST', headers, body: JSON.stringify({ email, role }) });
}

export function setMemberRole(userId: string, role: Role): Promise<Response> {
  return fetch(`/v1/members/${userId}`, { method: 'PATCH', headers, body: JSON.stringify({ role }) });
}

export function removeMember(userId: string): Promise<Response> {
  return fetch(`/v1/members/${userId}`, { method: 'DELETE', headers });
}

/**
 * A capability, as a record rather than a string on two objects (migration 0006).
 *
 * The field names are A2A's `AgentSkill` on purpose — `docs/01` already names AgentCard as an
 * agent's capability document, and the charter's layer-reference says a capability registry must
 * not invent a replacement for A2A. A future AgentCard is a projection of these, not a
 * translation.
 */
export interface CapabilityRecord {
  id: string;
  key: string;
  name: string;
  description: string | null;
  tags: string[];
  examples: string[];
  /** `inferred` means it turned up in use and nobody ever defined it. */
  origin: 'declared' | 'inferred';
  /** Where it is also known — an OASF dotted id, say. Null is the normal state. */
  externalId: string | null;
  externalSource: string | null;
  /** A2A `AgentSkill.inputModes`/`outputModes`. Stored and projected, never enforced. */
  inputModes: string[];
  outputModes: string[];
  /** What holding this also implies holding. Absent when it implies nothing. */
  implies?: string[];
  /** How many agents hold it, and how many boards name it on a stage. */
  agentCount: number;
  boardCount: number;
}

/** An edge in the workspace's implication graph: holding `from` also means holding `to`. */
export interface Implication {
  from: string;
  to: string;
}

export async function getImplications(): Promise<Implication[]> {
  const res = await fetch('/v1/capabilities/implications', { headers });
  if (!res.ok) return [];
  return ((await res.json()) as { implications: Implication[] }).implications;
}

export function addImplication(from: string, to: string): Promise<Response> {
  return fetch('/v1/capabilities/implications', {
    method: 'POST',
    headers,
    body: JSON.stringify({ from, to }),
  });
}

export function removeImplication(from: string, to: string): Promise<Response> {
  return fetch(
    `/v1/capabilities/implications?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { method: 'DELETE', headers },
  );
}

export async function getCapabilities(): Promise<CapabilityRecord[]> {
  const res = await fetch('/v1/capabilities', { headers });
  if (!res.ok) return [];
  return ((await res.json()) as { capabilities: CapabilityRecord[] }).capabilities;
}

export function createCapability(input: { key: string; name?: string; description?: string }): Promise<Response> {
  return fetch('/v1/capabilities', { method: 'POST', headers, body: JSON.stringify(input) });
}

export function updateCapability(
  id: string,
  patch: { name?: string; description?: string | null; tags?: string[]; examples?: string[]; externalId?: string | null; externalSource?: string | null },
): Promise<Response> {
  return fetch(`/v1/capabilities/${id}`, { method: 'PATCH', headers, body: JSON.stringify(patch) });
}

export function deleteCapability(id: string): Promise<Response> {
  return fetch(`/v1/capabilities/${id}`, { method: 'DELETE', headers });
}

/** The tenant's label catalogue (migration 0010). Tenant-scoped, not board-scoped — see `/v1/labels`. */
export async function listLabels(): Promise<Label[]> {
  const res = await fetch('/v1/labels', { headers });
  if (!res.ok) return [];
  return ((await res.json()) as { labels: Label[] }).labels;
}

export function createLabel(input: { name: string; colour: string }): Promise<Response> {
  return fetch('/v1/labels', { method: 'POST', headers, body: JSON.stringify(input) });
}

export function updateLabel(id: string, patch: { name?: string; colour?: string }): Promise<Response> {
  return fetch(`/v1/labels/${id}`, { method: 'PATCH', headers, body: JSON.stringify(patch) });
}

export function deleteLabel(id: string): Promise<Response> {
  return fetch(`/v1/labels/${id}`, { method: 'DELETE', headers });
}

/**
 * Projects and milestones (Task 18's `migration 0013`, `apps/api/src/db/projects.ts`) — a
 * project groups cards ACROSS boards, the same way a label does, and until this had no caller in
 * the web app at all. The envelopes below are read off `apps/api/src/index.ts` directly rather
 * than guessed, because this task shipped after the routes and the brief did not specify them.
 */
export type ProjectState = 'planned' | 'active' | 'paused' | 'completed' | 'canceled';
export type ProjectHealth = 'on-track' | 'at-risk' | 'off-track';

export interface Project {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  targetDate: string | null;
  state: ProjectState;
  health: ProjectHealth | null;
  leadUserId: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface Milestone {
  id: string;
  projectId: string;
  tenantId: string;
  name: string;
  targetDate: string | null;
  sortOrder: number;
  createdAt: string;
}

/**
 * A project's cross-board rollup (Task 19's `GET /v1/projects/:id/rollup`), cached in D1 for up
 * to 60 seconds and recomputed by fanning out to every board that carries this project's cards.
 *
 * `partial` and `boardsUnanswered` are deliberately NOT optional. When a board's Durable Object
 * does not answer, the server marks the whole total incomplete rather than quietly returning a
 * wrong number (`db/projects.ts`'s `computeRollup`) — and persists that admission, so a reader
 * served from the cache sees it too. Both fields are required here, not `?:`, so a caller cannot
 * destructure `cardsTotal`/`costUsd` out of this type without `partial`/`boardsUnanswered` also
 * being present on the value in hand: there is no narrower type that drops them to get at the
 * numbers. Rendering a total without reading them is still possible at the call site — this type
 * cannot force a render — but it cannot happen by the field being silently absent or typed away.
 */
export interface ProjectRollup {
  projectId: string;
  cardsTotal: number;
  cardsDone: number;
  cardsOverdue: number;
  costUsd: number;
  computedAt: string;
  partial: boolean;
  boardsUnanswered: number;
}

/** The workspace's projects. Answers an empty list rather than throwing when the read is refused. */
export async function listProjects(): Promise<Project[]> {
  const res = await fetch('/v1/projects', { headers });
  if (!res.ok) return [];
  return ((await res.json()) as { projects: Project[] }).projects;
}

/**
 * One project and its milestones, already in `sortOrder` (the server's own order, `db/projects.ts`
 * `listMilestones`). Null for a 404 — a project id that no longer resolves is the expected shape
 * of a stale link, not a thrown error (see `Card.projectId`'s comment).
 */
export async function getProject(id: string): Promise<{ project: Project; milestones: Milestone[] } | null> {
  const res = await fetch(`/v1/projects/${id}`, { headers });
  if (!res.ok) return null;
  return (await res.json()) as { project: Project; milestones: Milestone[] };
}

/**
 * Declare a project. Returns the raw response, like `createSchedule` does, so a caller can show
 * the server's own refusal verbatim — a 409 names the exact project the name collides with.
 */
export function createProject(input: {
  name: string;
  description?: string;
  targetDate?: string;
  leadUserId?: string;
}): Promise<Response> {
  return fetch('/v1/projects', { method: 'POST', headers, body: JSON.stringify(input) });
}

export function updateProject(
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    targetDate: string | null;
    state: ProjectState;
    health: ProjectHealth | null;
    leadUserId: string | null;
  }>,
): Promise<Response> {
  return fetch(`/v1/projects/${id}`, { method: 'PATCH', headers, body: JSON.stringify(patch) });
}

/**
 * Delete a project, unconditionally — the route does not check for cards still carrying its id,
 * the same reasoning as `deleteLabel` (see the long comment on `deleteProject` in
 * `apps/api/src/db/projects.ts`). A card's `projectId` going stale afterwards is the expected
 * result, not a bug this call could have prevented.
 */
export function deleteProject(id: string): Promise<Response> {
  return fetch(`/v1/projects/${id}`, { method: 'DELETE', headers });
}

/** Add a milestone to a project. Returns the raw response so a caller can show a validation refusal. */
export function createMilestone(
  projectId: string,
  input: { name: string; targetDate?: string; sortOrder?: number },
): Promise<Response> {
  return fetch(`/v1/projects/${projectId}/milestones`, { method: 'POST', headers, body: JSON.stringify(input) });
}

/** Remove one milestone, without deleting its project. */
export function deleteMilestone(milestoneId: string): Promise<Response> {
  return fetch(`/v1/milestones/${milestoneId}`, { method: 'DELETE', headers });
}

/**
 * The cached (or freshly computed) cross-board rollup for one project.
 *
 * **Throws on failure, like `getUsage` does, rather than returning zeros or a `partial: true`
 * placeholder.** A rollup the client invented to cover a failed fetch is exactly the dishonesty
 * `partial` exists to name when the SERVER could not complete it — inventing one locally on top
 * would undermine the same guarantee from the other direction.
 */
export async function getProjectRollup(projectId: string): Promise<ProjectRollup> {
  const res = await fetch(`/v1/projects/${projectId}/rollup`, { headers });
  if (!res.ok) throw new Error(`getProjectRollup failed (${res.status})`);
  return ((await res.json()) as { rollup: ProjectRollup }).rollup;
}

/** This workspace, and the hub fleet it is linked to (or null for a standalone board). */
export interface WorkspaceTenant {
  id: string;
  slug: string;
  name: string;
  externalId: string | null;
  externalSource: string | null;
}

/** Read this workspace, so an operator can see whether it is linked to a hub fleet. */
export async function getWorkspace(): Promise<WorkspaceTenant | null> {
  const res = await fetch('/v1/tenant', { headers });
  if (!res.ok) return null;
  return ((await res.json()) as { tenant: WorkspaceTenant }).tenant;
}

/**
 * Link (or, with `null`, unlink) this workspace to a hub fleet.
 *
 * The counterpart of {@link setAgentPrincipal} one plane up, and the operator-facing half of the
 * whole-branch review's Important: `tenants.external_id` had no writer at all, while BOTH
 * `resolveHubUser` and `resolveHubAgent` require it before any hub-issued credential can do
 * anything here — so the row existed only where somebody had made it by hand. Linking an agent
 * is useless while the fleet it belongs to is unlinked, which is why this belongs beside that
 * control rather than in a settings page nobody visits.
 *
 * Returns the raw response so the caller can read the server's own refusal (a malformed fleet id)
 * rather than a generic failure, exactly as `setAgentPrincipal` does.
 */
/**
 * This workspace's forge host, shown and set.
 *
 * Its own route rather than part of `PATCH /v1/tenant`: that one is human-only because a hub
 * token cannot establish the mapping that makes a hub token resolve, and the forge host has no
 * such bootstrap problem.
 */
export async function getForgeHost(): Promise<string | null> {
  const res = await fetch('/v1/tenant/forge', { headers });
  if (!res.ok) return null;
  return ((await res.json()) as { forgeHost: string | null }).forgeHost;
}

export function setForgeHost(forgeHost: string | null): Promise<Response> {
  return fetch('/v1/tenant/forge', { method: 'PUT', headers, body: JSON.stringify({ forgeHost }) });
}

export function setWorkspaceFleet(externalId: string | null): Promise<Response> {
  return fetch('/v1/tenant', { method: 'PATCH', headers, body: JSON.stringify({ externalId }) });
}

/**
 * Revoke ONE token, not the agent. Immediate and irreversible: `findAgentByTokenHash` refuses a
 * revoked token on every request from the moment this call succeeds — there is no undo.
 */
export function revokeAgentToken(agentId: string, tokenId: string): Promise<Response> {
  return fetch(`/v1/agents/${agentId}/tokens/${tokenId}`, { method: 'DELETE', headers });
}

/**
 * One message from the board's live feed.
 *
 * The DO sends a `snapshot` on connect and an `event` for everything after — including one per
 * activity (`emit('activity', { runId, cardId, activityType })` in `postActivity`). `cardId` is
 * the part that matters to a subscriber watching one card: without it every listener has to
 * refetch on every event or none at all.
 */
export interface BoardFeedEvent {
  seq: number;
  type: string;
  payload: { cardId?: string; runId?: string; [k: string]: unknown };
  ts: string;
}

/**
 * Subscribe to the board's live event feed.
 *
 * `onEvent` receives the parsed event, or `null` for the opening snapshot and for anything that
 * will not parse. It used to receive nothing at all — `() => onEvent()` discarded the message —
 * so no subscriber could tell WHICH card had changed, and the only listener refetched the whole
 * board on every event while the open card's own activity list refreshed on nothing. A run posted
 * 67 activities, every one of them delivered here, and the card drawer showed none of them.
 */
export function openBoardSocket(boardId: string, onEvent: (event: BoardFeedEvent | null) => void): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/v1/boards/${boardId}/ws?tenant=${TENANT}`);
  ws.addEventListener('message', (e) => {
    let parsed: BoardFeedEvent | null = null;
    try {
      const msg = JSON.parse(String(e.data)) as { kind?: string; event?: BoardFeedEvent };
      if (msg.kind === 'event' && msg.event) parsed = msg.event;
    } catch {
      // A message we cannot read is still a message: the board changed, so the caller should
      // still refresh. It simply learns nothing about what changed.
    }
    onEvent(parsed);
  });
  return ws;
}
