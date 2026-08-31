/**
 * Thin client for the Kaambaan API (apps/api). The deployed app authenticates with a session cookie
 * (sent automatically, same-origin); the `X-Tenant-Id` header is a no-op there and only enables the
 * local dev workspace (when the server runs with DEV_AUTH on).
 */
import { withAuthority } from './hub-token';

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
  /** Active (non-revoked) token ids. Empty means this agent cannot authenticate right now. */
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

export interface CardActivities {
  activities: Activity[];
  handoff: Record<string, unknown> | null;
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
  github: { issueTrigger: boolean; webhookConfigured: boolean };
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

export const BOARD_TEMPLATES: BoardTemplate[] = [
  {
    id: 'agent-pipeline',
    name: 'Agent pipeline',
    description: 'A general agent flow: Research → Review (your approval) → Publish.',
    stages: [
      { key: 'research', name: 'Research', order: 0, ownerKind: 'capability', owner: 'research' },
      { key: 'review', name: 'Review', order: 1, ownerKind: 'human', gate: 'approval' },
      { key: 'publish', name: 'Publish', order: 2, ownerKind: 'capability', owner: 'publish' },
    ],
  },
  {
    id: 'software',
    name: 'Software delivery',
    description: 'Ship code with a review gate: Backlog → Implement → Code review → QA → Deploy.',
    stages: [
      { key: 'backlog', name: 'Backlog', order: 0, ownerKind: 'human' },
      { key: 'implement', name: 'Implement', order: 1, ownerKind: 'capability', owner: 'code', wipLimit: 3 },
      { key: 'code-review', name: 'Code review', order: 2, ownerKind: 'human', gate: 'approval' },
      { key: 'qa', name: 'QA', order: 3, ownerKind: 'capability', owner: 'test' },
      { key: 'deploy', name: 'Deploy', order: 4, ownerKind: 'capability', owner: 'deploy' },
    ],
  },
  {
    id: 'content',
    name: 'Content production',
    description: 'Idea to published: Brief → Research → Draft → Edit → Publish.',
    stages: [
      { key: 'brief', name: 'Brief', order: 0, ownerKind: 'human' },
      { key: 'research', name: 'Research', order: 1, ownerKind: 'capability', owner: 'research' },
      { key: 'draft', name: 'Draft', order: 2, ownerKind: 'capability', owner: 'writing' },
      { key: 'edit', name: 'Edit', order: 3, ownerKind: 'human', gate: 'approval' },
      { key: 'publish', name: 'Publish', order: 4, ownerKind: 'capability', owner: 'publish' },
    ],
  },
  {
    id: 'support',
    name: 'Support triage',
    description: 'Resolve tickets with oversight: Inbox → Triage → Draft reply → Approve → Send.',
    stages: [
      { key: 'inbox', name: 'Inbox', order: 0, ownerKind: 'human' },
      { key: 'triage', name: 'Triage', order: 1, ownerKind: 'capability', owner: 'triage' },
      { key: 'draft-reply', name: 'Draft reply', order: 2, ownerKind: 'capability', owner: 'support' },
      { key: 'approve', name: 'Approve', order: 3, ownerKind: 'human', gate: 'approval' },
      { key: 'send', name: 'Send', order: 4, ownerKind: 'capability', owner: 'send' },
    ],
  },
  {
    id: 'research-report',
    name: 'Research report',
    description: 'Question to report: Question → Gather → Analyze → Review → Report.',
    stages: [
      { key: 'question', name: 'Question', order: 0, ownerKind: 'human' },
      { key: 'gather', name: 'Gather', order: 1, ownerKind: 'capability', owner: 'research' },
      { key: 'analyze', name: 'Analyze', order: 2, ownerKind: 'capability', owner: 'analysis' },
      { key: 'review', name: 'Review', order: 3, ownerKind: 'human', gate: 'approval' },
      { key: 'report', name: 'Report', order: 4, ownerKind: 'capability', owner: 'writing' },
    ],
  },
  {
    id: 'data',
    name: 'Data pipeline',
    description: 'Move + check data: Source → Extract → Transform → Validate → Load.',
    stages: [
      { key: 'source', name: 'Source', order: 0, ownerKind: 'human' },
      { key: 'extract', name: 'Extract', order: 1, ownerKind: 'capability', owner: 'extract' },
      { key: 'transform', name: 'Transform', order: 2, ownerKind: 'capability', owner: 'transform' },
      { key: 'validate', name: 'Validate', order: 3, ownerKind: 'human', gate: 'approval' },
      { key: 'load', name: 'Load', order: 4, ownerKind: 'capability', owner: 'load' },
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
export async function createCard(boardId: string, title: string): Promise<void> {
  const res = await fetch(`/v1/boards/${boardId}/cards`, {
    method: 'POST',
    headers: await withAuthority(headers),
    body: JSON.stringify({ title }), // owner is the signed-in user, set by the server
  });
  if (!res.ok) throw new Error(`createCard failed (${res.status})`);
}

/** Edit a card's title / description (spec) / priority. */
export function updateCard(boardId: string, cardId: string, patch: { title?: string; spec?: Record<string, unknown>; priority?: number }): Promise<Response> {
  return fetch(`/v1/boards/${boardId}/cards/${cardId}`, { method: 'PATCH', headers, body: JSON.stringify(patch) });
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

/** Register an agent and mint its bearer token (shown once). */
export async function createAgent(name: string, capabilities: string[]): Promise<AgentToken> {
  const res = await fetch('/v1/agents', { method: 'POST', headers, body: JSON.stringify({ name, capabilities }) });
  if (!res.ok) throw new Error(`createAgent failed (${res.status})`);
  return (await res.json()) as AgentToken;
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

/** Cost/usage rollup for the telemetry view; `window` filters to a recent span. */
export async function getUsage(boardId: string, window: '5h' | '7d' = '7d'): Promise<UsageSummary> {
  const res = await fetch(`/v1/boards/${boardId}/usage?window=${window}`, { headers });
  if (!res.ok) {
    return { totalCostUsd: 0, estimatedCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, unpricedRecords: 0, byModel: [], byAgent: [], byCard: [] };
  }
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
