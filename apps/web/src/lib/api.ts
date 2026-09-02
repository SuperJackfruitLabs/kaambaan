/**
 * Thin client for the Kaambaan API (apps/api). The deployed app authenticates with a session cookie
 * (sent automatically, same-origin); the `X-Tenant-Id` header is a no-op there and only enables the
 * local dev workspace (when the server runs with DEV_AUTH on).
 */
import { hubToken, withAuthority } from './hub-token';

const TENANT = 'tnt_dev';
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
   * Active (non-revoked) token ids. Empty means this agent cannot authenticate with a `kbn_`
   * token right now — which for a linked agent is the ordinary state, since it authenticates
   * with hub-issued tokens instead.
   */
  tokenIds: string[];
}

export interface Stage {
  key: string;
  name: string;
  order: number;
  gate?: 'none' | 'approval';
  wipLimit?: number;
  routing?: 'pipeline' | 'manager';
  ownerKind?: 'capability' | 'human';
  owner?: string;
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

export const DEFAULT_STAGES: Stage[] = [
  { key: 'backlog', name: 'Backlog', order: 0 },
  { key: 'ready', name: 'Ready', order: 1 },
  { key: 'in-progress', name: 'In Progress', order: 2, wipLimit: 3 },
  { key: 'review', name: 'Review', order: 3, gate: 'approval' },
  { key: 'done', name: 'Done', order: 4 },
];

export interface BoardTemplate {
  id: string;
  name: string;
  description: string;
  stages: Stage[];
}

/**
 * Starting pipelines.
 *
 * **Rewritten 2026-09-03.** The templates that shipped asked for nine capabilities no agent in
 * any fleet held — `publish`, `test`, `deploy`, `triage`, `support`, `send`, `extract`,
 * `transform`, `load` — while the agent-creation UI offered three, of which two overlapped. That
 * gap is where the capability mismatch began: a board created from a template had lanes nothing
 * could ever claim, and nothing said so.
 *
 * These use a small vocabulary an operator can actually staff, and each names the capabilities it
 * needs so the mismatch is visible before the board exists rather than after. A stage whose
 * capability nobody holds is flagged in the dialog — a lane no agent can work is a real state,
 * not an error, but it should never be a surprise.
 */
export const BOARD_TEMPLATES: BoardTemplate[] = [
  {
    id: 'software',
    name: 'Software delivery',
    description: 'Plan, build, check, ship. Needs: planning, code, security.',
    stages: [
      { key: 'intake', name: 'Intake', order: 0, ownerKind: 'human' },
      { key: 'plan', name: 'Plan', order: 1, ownerKind: 'capability', owner: 'planning' },
      { key: 'build', name: 'Build', order: 2, ownerKind: 'capability', owner: 'code', wipLimit: 3 },
      { key: 'security-review', name: 'Security review', order: 3, ownerKind: 'capability', owner: 'security' },
      { key: 'sign-off', name: 'Sign-off', order: 4, ownerKind: 'human', gate: 'approval' },
      { key: 'shipped', name: 'Shipped', order: 5, ownerKind: 'human' },
    ],
  },
  {
    id: 'research-report',
    name: 'Research report',
    description: 'Question to written answer. Needs: research, analysis, writing.',
    stages: [
      { key: 'question', name: 'Question', order: 0, ownerKind: 'human' },
      { key: 'gather', name: 'Gather', order: 1, ownerKind: 'capability', owner: 'research' },
      { key: 'analyse', name: 'Analyse', order: 2, ownerKind: 'capability', owner: 'analysis' },
      { key: 'draft', name: 'Draft', order: 3, ownerKind: 'capability', owner: 'writing' },
      { key: 'review', name: 'Review', order: 4, ownerKind: 'human', gate: 'approval' },
      { key: 'published', name: 'Published', order: 5, ownerKind: 'human' },
    ],
  },
  {
    id: 'security',
    name: 'Security review',
    description: 'A finding, fixed and verified. Needs: security, code.',
    stages: [
      { key: 'reported', name: 'Reported', order: 0, ownerKind: 'human' },
      { key: 'assess', name: 'Assess', order: 1, ownerKind: 'capability', owner: 'security' },
      { key: 'fix', name: 'Fix', order: 2, ownerKind: 'capability', owner: 'code', wipLimit: 2 },
      { key: 'verify', name: 'Verify', order: 3, ownerKind: 'capability', owner: 'security' },
      { key: 'sign-off', name: 'Sign-off', order: 4, ownerKind: 'human', gate: 'approval' },
      { key: 'closed', name: 'Closed', order: 5, ownerKind: 'human' },
    ],
  },
  {
    id: 'onboarding',
    name: 'Onboarding',
    description: 'Bring someone or something up to working order. Needs: onboarding, writing.',
    stages: [
      { key: 'arrived', name: 'Arrived', order: 0, ownerKind: 'human' },
      { key: 'prepare', name: 'Prepare', order: 1, ownerKind: 'capability', owner: 'onboarding' },
      { key: 'document', name: 'Document', order: 2, ownerKind: 'capability', owner: 'writing' },
      { key: 'check', name: 'Check', order: 3, ownerKind: 'human', gate: 'approval' },
      { key: 'ready', name: 'Ready', order: 4, ownerKind: 'human' },
    ],
  },
  {
    id: 'simple',
    name: 'Simple board',
    description: 'A classic Kanban: Backlog → Ready → In Progress → Review → Done. All human lanes (you move the cards).',
    stages: DEFAULT_STAGES,
  },
];

export async function createBoard(name: string, stages: Stage[]): Promise<string> {
  const res = await fetch('/v1/boards', { method: 'POST', headers, body: JSON.stringify({ name, stages }) });
  if (!res.ok) throw new Error(`createBoard failed (${res.status})`);
  const data = (await res.json()) as { boardId: string };
  return data.boardId;
}

export async function getBoard(boardId: string): Promise<BoardSnapshot> {
  const res = await fetch(`/v1/boards/${boardId}`, { headers });
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
  detail?: { priority?: number; spec?: Record<string, unknown> },
): Promise<void> {
  const res = await fetch(`/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: await withAuthority(headers),
    // Owner is the signed-in user, set by the server. Priority and spec are sent only when given,
    // so a one-line dispatch produces exactly the request it always did.
    body: JSON.stringify({ title, ...(detail?.priority !== undefined ? { priority: detail.priority } : {}), ...(detail?.spec ? { spec: detail.spec } : {}) }),
  });
  if (!res.ok) throw new Error(`createCard failed (${res.status})`);
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
  patch: { title?: string; spec?: Record<string, unknown>; priority?: number; ownerUserId?: string },
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

/** Delete a card and everything scoped to it. */
export function deleteCard(boardId: string, cardId: string): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/cards/${cardId}`, { method: 'DELETE', headers });
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
  const res = await fetch(`/v1/boards/${boardId}/cards/${cardId}/activities`, { headers });
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
  });
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
 * the one call, and **no** `kbn_` token comes back: a linked agent
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
 * which could not work from `kaambaan.dev` and never did.** The hub's session
 * cookie is `SameSite=Lax` on another registrable domain, so the browser never
 * attached it; and the hub's admin middleware does not accept a hub-issued
 * token either, so holding one would not have rescued it. `GET
 * /api/fleet/dispatchable` is the endpoint built for this question: a Bearer
 * token, no admin role, and it answers with the agents the token's own
 * `mayDispatch` names rather than every principal in the fleet.
 *
 * **Null is an ordinary result and must stay one** — a standalone kaambaan, an
 * operator who has not connected, an expired token, a hub that is down. The
 * caller shows nothing rather than an error, because a kaambaan with no hub is
 * not a broken kaambaan (migration 0003).
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
 * Issue a fresh `kbn_` token for an agent that already exists.
 *
 * The missing half of revocation: the UI has always said a revoked agent "cannot authenticate
 * until reconnected", and there was no reconnect — tokens were minted only when an agent was
 * created. The plaintext comes back exactly once, as it does on create.
 */
export async function issueAgentToken(agentId: string): Promise<{ token: string; tokenId: string }> {
  const res = await fetch(`/v1/agents/${agentId}/tokens`, { method: 'POST', headers });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `issueAgentToken failed (${res.status})`);
  }
  return (await res.json()) as { token: string; tokenId: string };
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
  /** How many agents hold it, and how many boards name it on a stage. */
  agentCount: number;
  boardCount: number;
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

/** Subscribe to the board's live event feed; `onEvent` fires on every server message. */
export function openBoardSocket(boardId: string, onEvent: () => void): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/v1/boards/${boardId}/ws?tenant=${TENANT}`);
  ws.addEventListener('message', () => {
    onEvent();
  });
  return ws;
}
