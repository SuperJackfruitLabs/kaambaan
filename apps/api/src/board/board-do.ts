import { DurableObject } from 'cloudflare:workers';
import { canTransition, nextState, type GateDecision, type TaskEventType, type TaskState } from '@kaambaan/contract';
import type { Env } from '../env';
import { newId } from '../ids';
import { grantPermitsAgent, isControlPairEnforced } from '../auth/grant-match';
import { parseElicitationOptions } from './elicitation';
import { verifyGithubSignature } from '../references/github-signature';
import { mapGithubEvent } from '../references/github-events';
import { estimateCostUsd } from '../metering/pricing';
import { parseWindowMs } from '../metering/window';
import { signAndSend, type PushSender } from '../push/deliver';
import { isPublicHttpUrl } from '../push/ssrf';

/** JSON-serializable value — used for everything that crosses the Durable Object RPC boundary. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** How long an agent may go without a heartbeat before its run is reclaimed (docs/08 §3, ⚠️ OPEN). */
const HEARTBEAT_TIMEOUT_MS = 15 * 60 * 1000;
/** Consecutive failed/reclaimed runs before a card auto-blocks for a human (docs/08 §4, ⚠️ OPEN). */
const CIRCUIT_BREAKER_LIMIT = 2;
/** Push delivery attempts before a delivery is dead-lettered (docs/05 §4). */
const MAX_PUSH_ATTEMPTS = 5;
/**
 * How long after a delivery is queued the alarm drains it, doubling per attempt
 * (docs/05 §4): 5s, 10s, 20s, 40s, 80s, then dead-lettered.
 *
 * Before this existed, `dispatchPushDeliveries` was reachable only from `POST
 * …/push/dispatch` — so a queued delivery sat pending until something outside
 * the board happened to poke it. That was survivable for `work.available`,
 * which has the pull path underneath it, and is not survivable for a gate: a
 * gate that never rings is a card blocked forever on an approval nobody was
 * asked for.
 */
const PUSH_DRAIN_BASE_MS = 5_000;

/**
 * How much of the previous stage's handoff a gate carries into a room.
 *
 * A room is not a document store, and supermessage caps a custom event's
 * content at 8 KiB before a renderer ever sees it — so this is cut somewhere
 * regardless. Better to cut it deliberately here, where the whole value is
 * still in hand, than to have a client truncate a blob it cannot interpret.
 */
const HANDOFF_SUMMARY_MAX_CHARS = 600;

/**
 * The part of a handoff worth showing a reviewer.
 *
 * A handoff is arbitrary JSON — whatever the previous stage chose to hand
 * forward. Agents overwhelmingly put the readable part under `summary` or
 * `output`, so those are preferred; anything else is compacted so the reviewer
 * at least sees the shape rather than nothing.
 *
 * Returns null rather than "{}" for an empty handoff: a card carrying nothing
 * should show no summary row at all, not an empty one that reads like a bug.
 */
export function handoffSummary(raw: string | null): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all. Show it anyway — it is still what was handed forward.
    parsed = raw;
  }
  let text: string;
  if (typeof parsed === 'string') {
    text = parsed;
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    const preferred = [o.summary, o.output, o.result, o.text].find((v) => typeof v === 'string' && v.trim() !== '');
    text = typeof preferred === 'string' ? preferred : JSON.stringify(o);
    if (text === '{}') return null;
  } else {
    text = JSON.stringify(parsed);
  }
  text = text.trim();
  if (text === '') return null;
  return text.length > HANDOFF_SUMMARY_MAX_CHARS
    ? text.slice(0, HANDOFF_SUMMARY_MAX_CHARS - 1) + '…'
    : text;
}

/** The decisions a human can take at an approval gate (docs/08 §6). */
const DEFAULT_GATE_OPTIONS: GateOption[] = [
  { name: 'approve', title: 'Approve' },
  { name: 'request_changes', title: 'Request changes', interactive: true },
  { name: 'reject', title: 'Reject' },
];

/** A pipeline stage (board column). `ownerKind`/`owner` drive agent claim routing (docs/01, docs/04). */
export interface StageDef {
  key: string;
  name: string;
  order: number;
  ownerKind?: 'capability' | 'agent' | 'human';
  owner?: string; // a capability tag (ownerKind=capability) or an agentId (ownerKind=agent)
  gate?: 'none' | 'approval';
  wipLimit?: number;
  /** Stage routing strategy (docs/05 §7): `pipeline` (sequential handoff, default) vs `manager`. */
  routing?: 'pipeline' | 'manager';
}

/** A reusable agent configuration bundle (docs/05 §7). */
export interface ProfileInput {
  key: string;
  name?: string;
  harness?: string;
  model?: string;
  permissionPolicy?: string;
  autonomyLevel?: string;
  capabilities?: string[];
}

export interface ProfileView {
  key: string;
  name: string | null;
  harness: string | null;
  model: string | null;
  permissionPolicy: string | null;
  autonomyLevel: string | null;
  capabilities: string[];
}

export interface BoardInit {
  id: string;
  tenantId: string;
  name: string;
  stages: StageDef[];
}

export interface CardView {
  id: string;
  title: string;
  spec: JsonValue;
  ownerUserId: string;
  /**
   * The principal who last deliberately queued this card — its creator, or
   * whoever moved it into a dispatchable stage. Not the same as `ownerUserId`,
   * and null on a card created before this was recorded.
   *
   * This is what the control pair reads to ask "who may dispatch which agent"
   * at claim time; without it a claim has no principal to check.
   */
  queuedBy: string | null;
  /** What the queuer was permitted to dispatch, as granted when they queued it. */
  queuedGrant: string[] | null;
  currentStageKey: string;
  state: TaskState;
  delegateAgentId: string | null;
  priority: number;
  contextId: string;
  createdAt: string;
  updatedAt: string | null;
  /** Summed agent usage on this card (docs/07 §6); `overBudget` if it exceeds the per-card cap. */
  costUsd: number;
  overBudget: boolean;
  /** Number of runs (attempts) against this card (docs/07 §5). */
  attemptCount: number;
}

/** A registered push subscription (A2A PushNotificationConfig, docs/05 §4). */
export interface PushConfigInput {
  agentId: string;
  url: string;
  token: string;
  capabilities?: string[];
  events?: string[];
}

export interface PushDeliveryView {
  id: number;
  configId: string;
  url: string;
  body: string;
  status: string;
  attempts: number;
}

/** An in-app notification for a notify-worthy status transition (docs/07 §7). */
export interface NotificationView {
  seq: number;
  kind: string;
  cardId: string;
  userId: string | null;
  body: string;
  read: boolean;
  createdAt: string;
}

/** A pre-run cost estimate for a card's current stage, from historical runs (docs/07 §6). */
export interface EstimateView {
  stageKey: string;
  estimatedUsd: number | null;
  sampleSize: number;
}

/** A durable activity in a card's session-replay timeline (docs/07 §4). */
export interface ActivityView {
  seq: number;
  runId: string;
  type: string;
  ts: string;
  body: string | null;
  action: string | null;
  parameter: JsonValue | null;
  result: JsonValue | null;
  signal: string | null;
}

/**
 * The context of one run, as the agent that owns it may read it (docs/04 §3 `getCard`).
 *
 * This is the *whole* agent read surface: the card this run was claimed for, that card's stage, the
 * upstream handoff and the card's references — enough to do the work, and nothing about the rest of
 * the (tenant-shared) board.
 */
export interface RunContext {
  run: {
    runId: string;
    cardId: string;
    stageKey: string;
    leaseEpoch: number;
    status: string;
    outcome: string | null;
    startedAt: string;
    endedAt: string | null;
  };
  card: CardView;
  /** The card's *current* stage — null if the board's stage list no longer contains it. */
  stage: StageDef | null;
  handoff: JsonValue | null;
  references: ReferenceView[];
  /**
   * The questions this run asked, oldest first, each carrying its answer once a human gives one.
   * This is how a blocked agent collects a decision: it re-reads the run it already holds, with the
   * token it already has. No human credential, and no second authorization rule.
   */
  elicitations: ElicitationView[];
}

/** One run of a card, surfaced for the attempts comparison view (docs/07 §5). */
export interface AttemptView {
  runId: string;
  cardId: string;
  stageKey: string;
  agentId: string;
  status: string;
  outcome: string | null;
  startedAt: string;
  endedAt: string | null;
  costUsd: number;
  model: string | null;
  profileKey: string | null;
}

/** Per-activity token/cost usage reported by an agent (docs/05 §1). */
export interface UsageInput {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface UsageSummary {
  totalCostUsd: number;
  estimatedCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Activities we metered but couldn't price (estimated, $0) — so unpriced spend isn't invisible. */
  unpricedRecords: number;
  byModel: Array<{ model: string; costUsd: number; inputTokens: number; outputTokens: number }>;
  byAgent: Array<{ agentId: string; costUsd: number }>;
  byCard: Array<{ cardId: string; costUsd: number }>;
}

export interface BoardEvent {
  seq: number;
  type: string;
  payload: JsonValue;
  ts: string;
}

/**
 * A choice presented to a human — at an approval gate, or on an agent's elicitation (HumanLayer-style
 * options, docs/08 §6). A gate is an elicitation with a `select` signal, so both use one shape.
 */
export interface GateOption {
  name: string;
  title: string;
  promptFill?: string;
  interactive?: boolean;
}

/**
 * An agent's open question to a human (docs/04 §4), persisted so it can be answered.
 *
 * The agent asks by posting an `elicitation` activity — `body` is the question, `parameter` carries
 * the `options` — which parks the card in `input-required` (or `auth-required` on an `auth` signal)
 * while the agent keeps its lease. A human's answer transitions the card back to `working` through
 * the state machine's own `human_reply` / `account_linked` transition, and the asking agent collects
 * the answer from the run it already owns.
 *
 * `agentId` is who asked — and therefore who may not answer.
 */
export interface ElicitationView {
  id: string;
  cardId: string;
  runId: string;
  stageKey: string;
  agentId: string;
  question: string;
  signal: string | null;
  options: GateOption[];
  status: ElicitationStatus;
  answer: ElicitationAnswer | null;
  createdAt: string;
}

/**
 * `pending` — waiting on a human. `answered` — a human replied and the card moved on.
 * `cancelled` — the question outlived its usefulness (the run ended, or the card was moved/superseded)
 * and can no longer be answered, so no stale prompt is left for a human to act on.
 */
export type ElicitationStatus = 'pending' | 'answered' | 'cancelled';

export interface ElicitationAnswer {
  option: string | null;
  text: string | null;
  answeredBy: string;
  answeredAt: string;
}

// Defined in `@kaambaan/contract` — it is a cross-repo contract value that
// AgentPod's bridge and supermessage both read. Re-exported so the many
// existing importers of it from this module keep working.
export type { GateDecision };

export interface GateView {
  id: string;
  cardId: string;
  stageKey: string;
  status: 'pending' | 'resolved';
  decision: string | null;
  options: GateOption[];
  producedBy: string;
  createdAt: string;
  /**
   * Who decided, and what they said.
   *
   * Both columns have been written on every resolution since gates existed and appeared in no
   * read shape at all — so who approved what, and the feedback they gave with it, was recorded
   * and unreadable. An approval nobody can attribute is not much of an approval.
   *
   * Null while pending, which is the ordinary state for everything this method returns.
   */
  decidedBy: string | null;
  comment: string | null;
  resolvedAt: string | null;
}

/**
 * What a `gate.pending` carries — the same object however it travels.
 *
 * Pushed when the gate opens, and read back by the hub's reconciliation sweep
 * (`charter → decisions/2026-08-30-a-gate-closes-over-chat.md` §5). Two paths
 * deliver this; exactly one builds it, because a swept gate that rendered
 * differently from a pushed one would only ever be seen on the path that had
 * already failed once.
 *
 * The field names are the wire's, not the board's: `gateId` rather than `id`,
 * `options[].id`/`label` rather than `name`/`title`. They are pinned by
 * agentpod `fixtures/ecosystem-identity/matrix_gate_events.json`, which three
 * repositories validate against, so this shape stops being ours to rename.
 */
export interface GatePendingBody {
  event: 'gate.pending';
  boardId: string | null;
  cardId: string;
  gateId: string;
  stageKey: string;
  returnStageKey: string;
  cardTitle: string;
  producedBy: string;
  /** What the reviewer is being asked to approve; null when nothing was handed forward. */
  handoffSummary: string | null;
  options: Array<{ id: string; label: string }>;
  /** When the gate opened. The gate's own clock, so a re-read is byte-identical. */
  ts: string;
}

/** A first-class external link on a card (docs/06). Idempotent on (cardId, url). */
export interface ReferenceView {
  id: string;
  cardId: string;
  url: string;
  title: string | null;
  subtitle: string | null;
  provider: string;
  sourceType: string;
  externalId: string | null;
  metadata: JsonValue | null;
  syncState: 'synced' | 'stale' | 'error';
  lastSyncedAt: string | null;
  addedBy: 'agent' | 'user';
  createdAt: string;
  updatedAt: string | null;
}

export interface ReferenceInput {
  cardId: string;
  url: string;
  provider: string;
  sourceType: string;
  title?: string;
  subtitle?: string;
  externalId?: string;
  metadata?: JsonValue;
  addedBy?: 'agent' | 'user';
  syncState?: 'synced' | 'stale' | 'error';
  lastSyncedAt?: string;
}

export interface BoardSnapshot {
  boardId: string | null;
  tenantId: string | null;
  name: string | null;
  stages: StageDef[];
  cards: CardView[];
  gates: GateView[];
  /** The questions agents are currently blocked on, waiting for a human (docs/04 §4). */
  elicitations: ElicitationView[];
  references: ReferenceView[];
  usage: BoardUsage;
  github: {
    issueTrigger: boolean;
    webhookConfigured: boolean;
    /**
     * How many principals the board's standing trigger grant names, or null when
     * no grant is recorded.
     *
     * The count, never the ids: this snapshot is read by every board viewer, and
     * which agents a particular operator may dispatch is that operator's
     * business. What a viewer needs to know is whether automation on this board
     * is authorised at all — because a board wired to a repository with no grant
     * produces cards no agent can ever claim.
     */
    triggerGrantCount: number | null;
  };
}

/** Board-level cost rollup + budget state (docs/07 §6). */
export interface BoardUsage {
  totalCostUsd: number;
  estimatedCostUsd: number;
  budgetUsd: number | null;
  cardUsdCap: number | null;
  overBudget: boolean;
}

/** The outcome of an agent claim — either work to do, or nothing available (docs/04 §3). */
export type ClaimResult =
  | {
      claimed: true;
      runId: string;
      leaseEpoch: number;
      card: CardView;
      stage: StageDef;
      handoff: JsonValue | null;
    }
  | { claimed: false };

/** Typed agent activity (docs/04 §4). `prompt` is human-authored and not posted by agents. */
export type AgentActivityType = 'thought' | 'action' | 'response' | 'elicitation' | 'error';

/**
 * Business outcomes are returned as values (not thrown). Throwing across the Durable Object RPC
 * boundary surfaces as an unhandled rejection in the runtime (docs/03, docs/08).
 */
export type BoardErrorCode =
  | 'NOT_INITIALIZED'
  | 'UNKNOWN_STAGE'
  | 'WIP_LIMIT'
  | 'CARD_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'NOT_RUN_OWNER'
  | 'STALE_LEASE'
  | 'GATE_NOT_FOUND'
  | 'GATE_NOT_PENDING'
  | 'ELICITATION_NOT_FOUND'
  | 'ELICITATION_NOT_PENDING'
  | 'INVALID_ANSWER'
  | 'CARD_NOT_WAITING'
  | 'SEPARATION_OF_DUTIES'
  | 'INVALID_URL'
  | 'INVALID_SIGNATURE'
  | 'NOT_CONFIGURED'
  | 'INVALID_DELIVERY'
  | 'INVALID_USAGE'
  | 'INVALID_STAGES'
  | 'STAGE_NOT_EMPTY'
  | 'BUDGET_EXCEEDED';

export type Result<T> = { ok: true; value: T } | { ok: false; code: BoardErrorCode; message: string };

/** The Board DO's RPC surface as the Worker calls it — hand-typed to avoid deep RPC type instantiation. */
export interface BoardStub {
  init(board: BoardInit): Promise<BoardSnapshot>;
  createCard(input: {
    /** What the queuer was permitted to dispatch, as granted at this moment. */
    queuedGrant?: string[] | null;
    title: string;
    ownerUserId: string;
    spec?: JsonValue;
    priority?: number;
  }): Promise<Result<CardView>>;
  moveCard(
    cardId: string,
    toStageKey: string,
    actorUserId?: string,
    /** What the mover was permitted to dispatch, recorded with the card. */
    queuedGrant?: string[] | null,
  ): Promise<Result<CardView>>;
  updateCard(cardId: string, patch: { title?: string; spec?: JsonValue; priority?: number; ownerUserId?: string }): Promise<Result<CardView>>;
  deleteCard(cardId: string): Promise<Result<{ ok: true }>>;
  setName(name: string): Promise<Result<{ ok: true }>>;
  setStages(stages: StageDef[]): Promise<Result<{ stages: StageDef[] }>>;
  destroy(): Promise<{ ok: true }>;
  getState(): Promise<BoardSnapshot>;
  getEvents(limit?: number): Promise<BoardEvent[]>;
  // Agent contract (docs/04 §3)
  claim(input: { agentId: string; capabilities: string[]; maxConcurrency?: number; profileKey?: string; principalId?: string | null }): Promise<ClaimResult>;
  setProfile(input: ProfileInput): Promise<Result<{ key: string }>>;
  getProfiles(): Promise<ProfileView[]>;
  heartbeat(input: RunVerbInput): Promise<Result<{ acknowledged: true }>>;
  postActivity(input: AgentActivityInput): Promise<Result<{ accepted: true; cardState: TaskState }>>;
  complete(input: RunVerbInput & { handoff?: JsonValue }): Promise<Result<CardView>>;
  block(input: RunVerbInput & { reason: string }): Promise<Result<CardView>>;
  fail(input: RunVerbInput & { reason: string }): Promise<Result<CardView>>;
  release(input: RunVerbInput & { reason?: string }): Promise<Result<CardView>>;
  submitForReview(input: RunVerbInput & { output?: JsonValue }): Promise<Result<CardView>>;
  addReference(input: ReferenceInput): Promise<Result<ReferenceView>>;
  setBudget(input: { boardUsdCap?: number | null; cardUsdCap?: number | null }): Promise<Result<{ ok: true }>>;
  getUsage(opts?: { window?: string }): Promise<UsageSummary>;
  getAttempts(cardId: string): Promise<AttemptView[]>;
  getRunContext(input: { runId: string; agentId?: string | null }): Promise<Result<RunContext>>;
  countReadyForCapabilities(agentId: string, capabilities: string[]): Promise<number>;
  getCardActivities(cardId: string): Promise<{ activities: ActivityView[]; handoff: JsonValue | null; gates: GateView[] }>;
  getEvents(limit?: number): Promise<BoardEvent[]>;
  estimateCardCost(cardId: string): Promise<Result<EstimateView>>;
  getNotifications(opts?: { unreadOnly?: boolean; userId?: string }): Promise<NotificationView[]>;
  markNotificationRead(seq: number): Promise<Result<{ ok: true }>>;
  registerPushConfig(input: PushConfigInput): Promise<Result<{ configId: string }>>;
  getPushDeliveries(opts?: { status?: string }): Promise<PushDeliveryView[]>;
  pendingGateDeliveries(): Promise<GatePendingBody[]>;
  dispatchPushDeliveries(): Promise<{ sent: number; failed: number }>;
  setGithubSecret(secret: string): Promise<Result<{ configured: true }>>;
  setGithubConfig(input: { secret?: string; issueTrigger?: boolean; triggerGrant?: string[] | null }): Promise<Result<{ ok: true }>>;
  createCardFromTrigger(input: {
    title: string;
    ownerUserId: string;
    spec?: JsonValue;
    queuedGrant?: string[] | null;
    source?: { url: string; provider?: string; sourceType?: string; externalId?: string; title?: string; metadata?: JsonValue };
  }): Promise<Result<{ card: CardView; reference: ReferenceView | null; referenceError?: string }>>;
  handleGithubWebhook(input: {
    rawBody: string;
    signature: string | null;
    deliveryId: string | null;
    event: string;
  }): Promise<Result<{ deduped: boolean; matched: number; modeled: boolean }>>;
  resolveGate(input: {
    gateId: string;
    decision: GateDecision;
    decidedBy: string;
    comment?: string;
  }): Promise<Result<CardView>>;
  answerElicitation(input: {
    elicitationId: string;
    answeredBy: string;
    option?: string;
    text?: string;
  }): Promise<Result<{ card: CardView; elicitation: ElicitationView }>>;
  fetch(request: Request): Promise<Response>;
}

export interface AgentActivityInput extends RunVerbInput {
  type: AgentActivityType;
  ephemeral?: boolean;
  body?: string;
  action?: string;
  parameter?: JsonValue;
  result?: JsonValue;
  signal?: string;
  usage?: UsageInput;
}

type Row = Record<string, SqlStorageValue>;

/** The outcome of the run-verb gate: the run row, or the refusal to hand back (assignable to `Result`). */
type RunAuth = { ok: true; run: Row } | { ok: false; code: 'NOT_RUN_OWNER' | 'STALE_LEASE'; message: string };

/**
 * Every run verb carries the authenticated agent alongside the lease (docs/04 §1). `agentId` is
 * the principal the edge resolved from the token — never a value the client asserts.
 */
export interface RunVerbInput {
  runId: string;
  leaseEpoch: number;
  agentId?: string | null;
}

/**
 * Board Durable Object — one instance per (tenant, board). The single-threaded DO is the live
 * authority for the board: card state in DO SQLite, an append-only event log, atomic mutations,
 * and a hibernatable WebSocket hub (docs/02, docs/07).
 *
 * P2 adds the agent execution loop (docs/04, docs/08): agents claim ready cards (capability-routed,
 * concurrency-limited), heartbeat, stream activities, and finish via complete/block/fail/release.
 * Each claim takes a lease with a fencing epoch; a missed heartbeat is reclaimed via a DO alarm,
 * and repeated failures trip a circuit breaker.
 */
const defaultPushSender: PushSender = (url, init) => fetch(url, init).then((r) => ({ status: r.status }));

export class BoardDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        spec_json TEXT NOT NULL DEFAULT '{}',
        owner_user_id TEXT NOT NULL,
        current_stage_key TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'submitted',
        priority INTEGER NOT NULL DEFAULT 0,
        context_id TEXT NOT NULL,
        delegate_agent_id TEXT,
        current_run_id TEXT,
        claim_seq INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        handoff_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        stage_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT,
        last_heartbeat_ms INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_runs_card ON runs(card_id)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS activities (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        type TEXT NOT NULL,
        ephemeral INTEGER NOT NULL DEFAULT 0,
        body TEXT,
        action TEXT,
        detail_json TEXT,
        ts TEXT NOT NULL
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        ts TEXT NOT NULL
      )`,
    );
    // Per-activity cost/usage rollup source (docs/07 §6). `cost_usd` is REAL — fine for display and a
    // coarse dollar budget gate; migrate to integer micro-dollars if we ever pass-through-bill.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS usage_records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        estimated INTEGER NOT NULL DEFAULT 0,
        ts TEXT NOT NULL
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_usage_card ON usage_records(card_id)`);
    // Outbound push (docs/05 §4): per-agent PushNotificationConfig + a durable delivery queue.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS push_configs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        url TEXT NOT NULL,
        token TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        events_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(agent_id, url)
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS push_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_id TEXT NOT NULL,
        url TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_status INTEGER,
        created_at TEXT NOT NULL
      )`,
    );
    // Agent profiles (docs/05 §7): reusable configuration bundles, selected on claim.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS profiles (
        key TEXT PRIMARY KEY,
        name TEXT,
        harness TEXT,
        model TEXT,
        permission_policy TEXT,
        autonomy_level TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      )`,
    );
    // An attempt pins the profile it ran under (docs/05 §7) — added as a guarded migration.
    try {
      this.sql.exec(`ALTER TABLE runs ADD COLUMN profile_key TEXT`);
    } catch {
      // column already exists
    }
    /**
     * Who queued this card — the principal on whose behalf an agent runs it.
     *
     * The control pair asks "who may dispatch which agent"
     * (charter decisions/2026-08-13-ecosystem-identity.md, Decision 4), and to
     * answer that at claim time this board has to know who caused the card to
     * become claimable in the first place.
     *
     * It is NOT the same as `owner_user_id`: a card can be moved into a
     * dispatchable stage by someone other than the person who created it, and it
     * is the mover who dispatched.
     *
     * Nullable on purpose. A card reaches the claimable state from six places
     * and only two of them are a human act — creating it, and moving it. The
     * other four are automatic: a stage advancing after a run completes, a
     * release, a reclaim, a gate resolving. Those must NOT overwrite this: the
     * pipeline that follows is the continuation of the work a person queued, so
     * the value persists as "who last deliberately queued this card".
     */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN queued_by TEXT`);
    } catch {
      // column already exists
    }
    /** The queuer, pinned onto the run, so an attempt records whose work it was. */
    try {
      this.sql.exec(`ALTER TABLE runs ADD COLUMN queued_by TEXT`);
    } catch {
      // column already exists
    }
    /**
     * What the queuer was PERMITTED to dispatch, as granted at the moment they
     * queued it.
     *
     * Authority is captured at the moment of the act, not looked up later. An
     * agent claims work minutes or hours after a human queued it and the human
     * is not present, so there is no caller to ask "may you dispatch this?" —
     * the answer has to have been written down when it was still askable.
     *
     * Recorded as granted THEN. A later change to someone's grant does not
     * retroactively authorise or deauthorise work already queued, which is what
     * makes this an audit record and not a cache.
     *
     * NULL means no authorising token accompanied the act. Under enforcement
     * that card is not claimable — nobody with authority ever asked for it to
     * run.
     */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN queued_grant TEXT`);
    } catch {
      // column already exists
    }
    // In-app notifications (docs/07 §7): the notify-worthy status transitions, for the card owner.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS notifications (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        card_id TEXT NOT NULL,
        user_id TEXT,
        body TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS gates (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        stage_key TEXT NOT NULL,
        return_stage_key TEXT NOT NULL,
        status TEXT NOT NULL,
        decision TEXT,
        comment TEXT,
        produced_by TEXT NOT NULL DEFAULT '',
        decided_by TEXT,
        options_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gates_card ON gates(card_id)`);
    // An agent's open question to a human (docs/04 §4). Persisting it is what makes an answer
    // possible: the activity stream is append-only history, and history cannot be replied to.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS elicitations (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        stage_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        question TEXT NOT NULL,
        signal TEXT,
        options_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        answer_option TEXT,
        answer_text TEXT,
        answered_by TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_elicitations_card ON elicitations(card_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_elicitations_run ON elicitations(run_id)`);
    // `references` is a SQL keyword, so the table is `card_references`. UNIQUE(card_id, url) is the
    // idempotent-upsert dedup key (docs/06 §1).
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS card_references (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        provider TEXT NOT NULL,
        source_type TEXT NOT NULL,
        external_id TEXT,
        metadata_json TEXT,
        sync_state TEXT NOT NULL DEFAULT 'synced',
        last_synced_at TEXT,
        added_by TEXT NOT NULL DEFAULT 'agent',
        created_at TEXT NOT NULL,
        updated_at TEXT,
        UNIQUE(card_id, url)
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_refs_card ON card_references(card_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_refs_external ON card_references(external_id)`);
    // Inbound webhook delivery dedup (docs/06 §3): GitHub may redeliver the same X-GitHub-Delivery.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS webhook_deliveries (delivery_id TEXT PRIMARY KEY, received_at TEXT NOT NULL)`,
    );
  }

  // ----- RPC: board lifecycle -----

  async init(board: BoardInit): Promise<BoardSnapshot> {
    if (!this.getMeta('boardId')) {
      const stages = [...board.stages].sort((a, b) => a.order - b.order);
      this.setMeta('boardId', board.id);
      this.setMeta('tenantId', board.tenantId);
      this.setMeta('name', board.name);
      this.setMeta('stages', JSON.stringify(stages));
      this.emit('board.initialized', { boardId: board.id, tenantId: board.tenantId });
    }
    return this.snapshot();
  }

  async createCard(input: {
    /** What the queuer was permitted to dispatch, as granted at this moment. */
    queuedGrant?: string[] | null;
    title: string;
    ownerUserId: string;
    spec?: JsonValue;
    priority?: number;
  }): Promise<Result<CardView>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    const first = this.stages()[0];
    if (!first) return { ok: false, code: 'NOT_INITIALIZED', message: 'board has no stages' };
    const id = newId('card');
    const contextId = newId('ctx');
    const now = this.now();
    this.sql.exec(
      `INSERT INTO cards
        (id, title, spec_json, owner_user_id, current_stage_key, state, priority, context_id, created_at, updated_at, queued_by, queued_grant)
       VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?)`,
      id,
      input.title,
      JSON.stringify(input.spec ?? {}),
      input.ownerUserId,
      first.key,
      input.priority ?? 0,
      contextId,
      now,
      now,
      // Creating a card in the first stage IS queueing it: it is claimable the
      // moment it exists, so the creator is the principal who dispatched it.
      input.ownerUserId,
      input.queuedGrant ? JSON.stringify(input.queuedGrant) : null,
    );
    const card = this.mustGetCard(id);
    this.emit('card.created', { card });
    this.notifyWorkAvailable(id);
    return { ok: true, value: card };
  }

  /**
   * The one inbound-trigger path (docs/05 §6): every source (API, GitHub issue, Slack, schedule)
   * funnels here — create a card and attach the originating resource as a provenance reference.
   */
  async createCardFromTrigger(input: {
    title: string;
    ownerUserId: string;
    spec?: JsonValue;
    /**
     * The authority the caller carried, when there was a caller. A live human on
     * `POST /v1/boards/:id/triggers` has one; a GitHub webhook does not, and
     * falls back to the board's standing grant below.
     */
    queuedGrant?: string[] | null;
    source?: { url: string; provider?: string; sourceType?: string; externalId?: string; title?: string; metadata?: JsonValue };
  }): Promise<Result<{ card: CardView; reference: ReferenceView | null; referenceError?: string }>> {
    const created = await this.createCard({
      title: input.title,
      ownerUserId: input.ownerUserId,
      spec: input.spec,
      // Without this the automation path produced cards that could never be
      // claimed under enforcement — created, visible on the board, and parked on
      // first claim forever, on the one path with no human watching.
      queuedGrant: input.queuedGrant ?? this.triggerGrant(),
    });
    if (!created.ok) return { ok: false, code: created.code, message: created.message };
    let reference: ReferenceView | null = null;
    let referenceError: string | undefined;
    if (input.source) {
      const ref = await this.addReference({
        cardId: created.value.id,
        url: input.source.url,
        provider: input.source.provider ?? 'url',
        sourceType: input.source.sourceType ?? 'url',
        externalId: input.source.externalId,
        title: input.source.title,
        metadata: input.source.metadata,
        addedBy: 'agent',
      });
      // The card is created either way; surface a dropped reference (e.g. a bad source url) so the
      // caller knows provenance was not attached, rather than silently returning an unprovenanced card.
      if (ref.ok) reference = ref.value;
      else referenceError = ref.code;
    }
    return { ok: true, value: { card: created.value, reference, ...(referenceError ? { referenceError } : {}) } };
  }

  /** Human move (docs/03). Enforces stage existence and the target stage's WIP limit. */
  async moveCard(
    cardId: string,
    toStageKey: string,
    actorUserId?: string,
    queuedGrant?: string[] | null,
  ): Promise<Result<CardView>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    const card = this.getCard(cardId);
    if (!card) return { ok: false, code: 'CARD_NOT_FOUND', message: `card not found: ${cardId}` };
    const target = this.stages().find((s) => s.key === toStageKey);
    if (!target) return { ok: false, code: 'UNKNOWN_STAGE', message: `unknown stage: ${toStageKey}` };
    if (target.key === card.currentStageKey) return { ok: true, value: card };
    if (target.wipLimit !== undefined && this.countInStage(target.key) >= target.wipLimit) {
      return {
        ok: false,
        code: 'WIP_LIMIT',
        message: `WIP limit reached for stage "${target.key}" (limit ${target.wipLimit})`,
      };
    }
    const now = this.now();
    // A manual move overrides any in-flight review: cancel pending gates and return the card to a
    // clean, claimable state. Without this, dragging a card off a human gate strands it in
    // input-required with an orphaned pending gate that no agent can claim and no human can resolve.
    this.sql.exec(`UPDATE gates SET status = 'cancelled', resolved_at = ? WHERE card_id = ? AND status = 'pending'`, now, cardId);
    this.cancelElicitationsForCard(cardId);
    // A move by a person re-queues the card, so the mover becomes the queuer —
    // they are the one dispatching it now, which is not necessarily the person
    // who created it. Without an actor (an internal move) the previous queuer
    // stands: COALESCE leaves it alone rather than blanking it.
    this.sql.exec(
      `UPDATE cards SET current_stage_key = ?, state = 'submitted', delegate_agent_id = NULL, current_run_id = NULL,
              failure_count = 0, updated_at = ?, queued_by = COALESCE(?, queued_by),
              queued_grant = CASE WHEN ? IS NULL THEN queued_grant ELSE ? END WHERE id = ?`,
      target.key,
      now,
      actorUserId ?? null,
      // Same COALESCE reasoning as the queuer: an internal move leaves the
      // recorded authority standing rather than blanking it.
      queuedGrant === undefined || queuedGrant === null ? null : JSON.stringify(queuedGrant),
      queuedGrant === undefined || queuedGrant === null ? null : JSON.stringify(queuedGrant),
      cardId,
    );
    const updated = this.mustGetCard(cardId);
    this.emit('card.moved', {
      cardId,
      from: card.currentStageKey,
      to: target.key,
      by: actorUserId ?? null,
    });
    return { ok: true, value: updated };
  }

  /**
   * Edit a card's title / spec / priority / owner (human, docs/07 §4).
   *
   * `ownerUserId` is here because a card's owner was fixed to whoever created it, with no
   * reassign, no "assign to me" and no unassign — on a board whose whole purpose is handing work
   * between people and agents. It is deliberately NOT `queued_by`: who is answerable for a card
   * and who authorised its dispatch are different questions, and reassignment must not silently
   * rewrite the recorded authority a claim is checked against.
   */
  async updateCard(cardId: string, patch: { title?: string; spec?: JsonValue; priority?: number; ownerUserId?: string }): Promise<Result<CardView>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    if (!this.getCard(cardId)) return { ok: false, code: 'CARD_NOT_FOUND', message: `card not found: ${cardId}` };
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      vals.push(patch.title);
    }
    if (patch.spec !== undefined) {
      sets.push('spec_json = ?');
      vals.push(JSON.stringify(patch.spec));
    }
    if (patch.priority !== undefined) {
      sets.push('priority = ?');
      vals.push(patch.priority);
    }
    if (patch.ownerUserId !== undefined) {
      sets.push('owner_user_id = ?');
      vals.push(patch.ownerUserId);
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      vals.push(this.now());
      this.sql.exec(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`, ...vals, cardId);
    }
    const card = this.mustGetCard(cardId);
    this.emit('card.updated', { card });
    return { ok: true, value: card };
  }

  /** Delete a card and everything scoped to it (references, runs, activities, gates, usage, notifications). */
  async deleteCard(cardId: string): Promise<Result<{ ok: true }>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    if (!this.getCard(cardId)) return { ok: false, code: 'CARD_NOT_FOUND', message: `card not found: ${cardId}` };
    for (const t of ['usage_records', 'activities', 'runs', 'gates', 'elicitations', 'card_references', 'notifications']) {
      this.sql.exec(`DELETE FROM ${t} WHERE card_id = ?`, cardId);
    }
    this.sql.exec(`DELETE FROM cards WHERE id = ?`, cardId);
    this.emit('card.deleted', { cardId });
    return { ok: true, value: { ok: true } };
  }

  /** Rename the board (the catalog row is renamed alongside, by the Worker). */
  /**
   * Rework the board's pipeline, after it exists.
   *
   * Stages were written once — in `init`, and mirrored into the catalog row — and there was no
   * update route and no method here. Not one field could be changed afterwards: name, order, WIP
   * limit, approval gate, owner, routing. A mistyped stage name or a WIP limit set one too low
   * meant recreating the board and losing every card on it.
   *
   * **A stage key is identity, not a label.** Cards carry `current_stage_key`, runs carry
   * `stage_key`, and gates carry it too; renaming a key in place would orphan all three silently.
   * So every field is editable EXCEPT the key, and changing a key is expressed as adding one
   * stage and removing another — which the emptiness rule below then makes safe.
   *
   * **A stage that still holds cards cannot be removed.** Refusing is the only honest answer: the
   * alternatives are deleting the operator's work without being asked, or moving it somewhere
   * this method has no basis for choosing. The caller empties the stage and tries again.
   *
   * The whole payload is the new pipeline — a PUT, not a patch — because order is a property of
   * the list rather than of any stage in it, and a partial update cannot express a reorder.
   */
  async setStages(stages: StageDef[]): Promise<Result<{ stages: StageDef[] }>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    if (!Array.isArray(stages) || stages.length === 0) {
      return { ok: false, code: 'INVALID_STAGES', message: 'a board needs at least one stage' };
    }
    for (const s of stages) {
      if (!s || typeof s.key !== 'string' || s.key.trim() === '') {
        return { ok: false, code: 'INVALID_STAGES', message: 'every stage needs a key' };
      }
      if (typeof s.name !== 'string' || s.name.trim() === '') {
        return { ok: false, code: 'INVALID_STAGES', message: `stage "${s.key}" needs a name` };
      }
      if (s.wipLimit !== undefined && (!Number.isInteger(s.wipLimit) || s.wipLimit < 1)) {
        return { ok: false, code: 'INVALID_STAGES', message: `stage "${s.key}" needs a WIP limit of at least 1, or none` };
      }
    }
    const keys = stages.map((s) => s.key);
    const duplicate = keys.find((k, i) => keys.indexOf(k) !== i);
    if (duplicate) {
      // Two stages sharing a key is not a pipeline: `stages().find(...)` would resolve every card
      // in both to whichever came first, and the other would be unreachable.
      return { ok: false, code: 'INVALID_STAGES', message: `two stages share the key "${duplicate}"` };
    }

    const kept = new Set(keys);
    for (const existing of this.stages()) {
      if (kept.has(existing.key)) continue;
      const held = this.countInStage(existing.key);
      if (held > 0) {
        return {
          ok: false,
          code: 'STAGE_NOT_EMPTY',
          message: `stage "${existing.key}" still holds ${held} card${held === 1 ? '' : 's'} — move them before removing it`,
        };
      }
    }

    const ordered = [...stages].sort((a, b) => a.order - b.order);
    this.setMeta('stages', JSON.stringify(ordered));
    this.emit('board.stages_changed', { stages: ordered });
    return { ok: true, value: { stages: ordered } };
  }

  async setName(name: string): Promise<Result<{ ok: true }>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    this.setMeta('name', name);
    this.emit('board.renamed', { name });
    return { ok: true, value: { ok: true } };
  }

  async getState(): Promise<BoardSnapshot> {
    return this.snapshot();
  }

  /**
   * Erase this board.
   *
   * `DELETE /v1/boards/:id` removed the catalog row and nothing else, so the Durable Object and
   * every card, run, activity, gate, reference and usage record it held survived — unreachable
   * through any route, undeleted, and still billing storage. A person who deleted a board had
   * every reason to believe its contents were gone.
   *
   * Rows are deleted rather than `storage.deleteAll()`. On a SQLite-backed DO `deleteAll` drops
   * the tables themselves, and the schema is created in the constructor — so the live instance
   * would go on serving requests against tables that no longer exist, answering 500 where it
   * should answer "no such board". Emptying every table leaves `meta` with no `boardId`, which is
   * precisely how an uninitialised board already reads.
   *
   * The alarm goes too: a reclaim scheduled for a board that no longer exists would wake this
   * object for nothing, on a timer, forever.
   */
  async destroy(): Promise<{ ok: true }> {
    for (const t of [
      'usage_records',
      'activities',
      'runs',
      'gates',
      'elicitations',
      'card_references',
      'notifications',
      'push_deliveries',
      'push_configs',
      'profiles',
      'webhook_deliveries',
      'events',
      'cards',
      'meta',
    ]) {
      this.sql.exec(`DELETE FROM ${t}`);
    }
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  async getEvents(limit = 100): Promise<BoardEvent[]> {
    return this.sql
      .exec(`SELECT seq, type, payload_json, ts FROM events ORDER BY seq DESC LIMIT ?`, limit)
      .toArray()
      .reverse()
      .map((r) => ({
        seq: Number(r.seq),
        type: r.type as string,
        payload: JSON.parse(r.payload_json as string),
        ts: r.ts as string,
      }));
  }

  /**
   * Idempotent upsert of a first-class reference, keyed on (cardId, url) (docs/06 §1).
   *
   * **Full-replace (PUT) semantics**: a re-add overwrites the mutable fields (title, subtitle,
   * provider, sourceType, externalId, metadata, syncState) with what's supplied — omitted optionals
   * become null. Callers (and the P5.2 sync worker) must send the complete current record. The
   * identity fields (id, created_at, added_by) are preserved across updates.
   *
   * Only `http(s)` urls are accepted: a reference url renders as an outbound link in the board UI,
   * so rejecting other schemes (`javascript:`, `data:`, …) at the write boundary forecloses stored
   * XSS and is the first slice of the §6 SSRF allowlist.
   */
  async addReference(input: ReferenceInput): Promise<Result<ReferenceView>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    let scheme = '';
    try {
      scheme = new URL(input.url).protocol;
    } catch {
      scheme = '';
    }
    if (scheme !== 'http:' && scheme !== 'https:') {
      return { ok: false, code: 'INVALID_URL', message: `unsupported reference url scheme: ${input.url}` };
    }
    if (!this.getCardRow(input.cardId)) {
      return { ok: false, code: 'CARD_NOT_FOUND', message: `card not found: ${input.cardId}` };
    }
    const now = this.now();
    const metadataJson = input.metadata === undefined ? null : JSON.stringify(input.metadata);
    const existing = this.sql
      .exec(`SELECT id FROM card_references WHERE card_id = ? AND url = ?`, input.cardId, input.url)
      .toArray()[0];

    if (existing) {
      const id = existing.id as string;
      this.sql.exec(
        `UPDATE card_references
           SET title = ?, subtitle = ?, provider = ?, source_type = ?, external_id = ?,
               metadata_json = ?, sync_state = ?, last_synced_at = ?, updated_at = ?
         WHERE id = ?`,
        input.title ?? null,
        input.subtitle ?? null,
        input.provider,
        input.sourceType,
        input.externalId ?? null,
        metadataJson,
        input.syncState ?? 'synced',
        input.lastSyncedAt ?? null,
        now,
        id,
      );
      const ref = this.mustGetReference(id);
      this.emit('reference.updated', { reference: ref });
      return { ok: true, value: ref };
    }

    const id = newId('ref');
    this.sql.exec(
      `INSERT INTO card_references
        (id, card_id, url, title, subtitle, provider, source_type, external_id, metadata_json, sync_state, last_synced_at, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.cardId,
      input.url,
      input.title ?? null,
      input.subtitle ?? null,
      input.provider,
      input.sourceType,
      input.externalId ?? null,
      metadataJson,
      input.syncState ?? 'synced',
      input.lastSyncedAt ?? null,
      input.addedBy ?? 'agent',
      now,
    );
    const ref = this.mustGetReference(id);
    this.emit('reference.added', { reference: ref });
    return { ok: true, value: ref };
  }

  /** Store/rotate this board's GitHub webhook secret (docs/06 §3, §6). */
  async setGithubSecret(secret: string): Promise<Result<{ configured: true }>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    this.setMeta('githubWebhookSecret', secret);
    return { ok: true, value: { configured: true } };
  }

  /** Configure GitHub integration: webhook secret + whether opened issues auto-create cards (docs/05 §6). */
  async setGithubConfig(input: {
    secret?: string;
    issueTrigger?: boolean;
    /** See `triggerGrant()` — the standing authority for cards nobody is present to queue. */
    triggerGrant?: string[] | null;
  }): Promise<Result<{ ok: true }>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    if (input.secret !== undefined) this.setMeta('githubWebhookSecret', input.secret);
    if (input.issueTrigger !== undefined) this.setMeta('githubIssueTrigger', input.issueTrigger ? '1' : '0');
    if (input.triggerGrant !== undefined) this.setTriggerGrant(input.triggerGrant);
    return { ok: true, value: { ok: true } };
  }

  /**
   * The authority a card gets when nobody is present to carry one.
   *
   * Every other queueing path has a live human on the request, so the grant that
   * accompanies the act is read off their token. A GitHub webhook has none: the
   * person who wired the repository to this board is long gone by the time an
   * issue is opened. That wiring IS the act of authorising automated dispatch,
   * so the grant is captured then and stored here — the same answer, written
   * down while it was still askable, which is the whole shape of the control
   * pair (charter decisions/2026-08-13-ecosystem-identity.md, Decision 4).
   *
   * `null` stays an ordinary answer. A standalone board whose operator never
   * held a hub token records nothing, and under enforcement its trigger-born
   * cards park in `input-required` and say why — which is the honest outcome,
   * and is what the audit found happening silently to every such card.
   */
  private triggerGrant(): string[] | null {
    const raw = this.getMeta('triggerGrant');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as string[]) : null;
    } catch {
      return null;
    }
  }

  private setTriggerGrant(grant: string[] | null): void {
    // Cleared by deleting the row rather than storing "null": `getMeta` answers
    // null for an absent key, so an absent row and a cleared grant read the same
    // — one state, not two that a later reader has to tell apart.
    if (grant === null) this.sql.exec(`DELETE FROM meta WHERE k = ?`, 'triggerGrant');
    else this.setMeta('triggerGrant', JSON.stringify(grant));
  }

  /**
   * Ingest a GitHub webhook (docs/06 §3): verify the HMAC signature over the raw body, dedup on the
   * delivery id, then apply the draft-PR sub-state machine to every reference matching the event's
   * externalId. Verification + dedup + mutation are co-located here because the DO owns both the
   * board's secret and the references.
   */
  async handleGithubWebhook(input: {
    rawBody: string;
    signature: string | null;
    deliveryId: string | null;
    event: string;
  }): Promise<Result<{ deduped: boolean; matched: number; modeled: boolean }>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    const secret = this.getMeta('githubWebhookSecret');
    if (!secret) {
      return { ok: false, code: 'NOT_CONFIGURED', message: 'no github webhook secret configured for this board' };
    }
    if (!(await verifyGithubSignature(secret, input.rawBody, input.signature))) {
      return { ok: false, code: 'INVALID_SIGNATURE', message: 'invalid X-Hub-Signature-256' };
    }
    // Fail closed: GitHub always sends X-GitHub-Delivery, so a missing one means replay protection
    // would be silently disabled — reject rather than accept-without-dedup. (Dedup is recorded only
    // after signature verification, so an unverified request can never poison this table.)
    if (!input.deliveryId) {
      return { ok: false, code: 'INVALID_DELIVERY', message: 'missing X-GitHub-Delivery' };
    }
    const seen = this.sql.exec(`SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?`, input.deliveryId).toArray()[0];
    if (seen) return { ok: true, value: { deduped: true, matched: 0, modeled: false } };
    this.sql.exec(`INSERT INTO webhook_deliveries (delivery_id, received_at) VALUES (?, ?)`, input.deliveryId, this.now());

    let payload: unknown;
    try {
      // Accept both webhook content types. GitHub's default (application/x-www-form-urlencoded) sends
      // `payload=<url-encoded json>`; application/json sends the raw JSON. The signature was already
      // verified over the raw body above, so unwrapping the form encoding here is safe.
      const raw = input.rawBody;
      const jsonText = raw.startsWith('payload=') ? (new URLSearchParams(raw).get('payload') ?? raw) : raw;
      payload = JSON.parse(jsonText);
    } catch {
      return { ok: true, value: { deduped: false, matched: 0, modeled: false } };
    }

    // Inbound trigger (docs/05 §6): an opened issue auto-creates a card when enabled for this board.
    const p = payload as Record<string, any>;
    if (input.event === 'issues' && p.action === 'opened' && this.getMeta('githubIssueTrigger') === '1') {
      const issue = p.issue as Record<string, any> | undefined;
      const fullName = (p.repository as Record<string, any> | undefined)?.full_name as string | undefined;
      if (issue && typeof issue.number === 'number' && fullName) {
        const externalId = `${fullName.toLowerCase()}#${issue.number}`;
        // Idempotency: don't create a second card if one already references this issue (a redelivery
        // with a fresh delivery-id, or a re-opened issue, would otherwise duplicate).
        const exists = this.sql.exec(`SELECT 1 FROM card_references WHERE external_id = ? LIMIT 1`, externalId).toArray()[0];
        if (!exists) {
          await this.createCardFromTrigger({
            title: (issue.title as string) ?? `Issue #${issue.number}`,
            ownerUserId: 'usr_github',
            source: { url: issue.html_url as string, provider: 'github', sourceType: 'issue', externalId },
          });
        }
      }
    }

    const mapped = mapGithubEvent(input.event, payload);
    if (!mapped) return { ok: true, value: { deduped: false, matched: 0, modeled: false } };

    const now = this.now();
    const rows = this.sql.exec(`SELECT * FROM card_references WHERE external_id = ?`, mapped.externalId).toArray();
    for (const row of rows) {
      const current = (row.metadata_json ? JSON.parse(row.metadata_json as string) : {}) as Record<string, unknown>;
      const merged = { ...current, ...mapped.metadata, subState: mapped.subState };
      this.sql.exec(
        `UPDATE card_references SET metadata_json = ?, sync_state = 'synced', last_synced_at = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(merged),
        now,
        now,
        row.id as string,
      );
      this.emit('reference.updated', { reference: this.mustGetReference(row.id as string) });
    }
    // `modeled: true` with `matched: 0` means "a known event for a PR/issue no card references yet"
    // — distinct from an unmodeled event or a parse miss (both `modeled: false`).
    return { ok: true, value: { deduped: false, matched: rows.length, modeled: true } };
  }

  /** Set or clear the board-level and per-card USD budget caps (docs/07 §6). `null` clears a cap. */
  async setBudget(input: { boardUsdCap?: number | null; cardUsdCap?: number | null }): Promise<Result<{ ok: true }>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    const apply = (key: string, value: number | null | undefined): void => {
      if (value === undefined) return;
      if (value === null) this.sql.exec(`DELETE FROM meta WHERE k = ?`, key);
      else this.setMeta(key, String(value));
    };
    apply('budgetBoardUsdCap', input.boardUsdCap);
    apply('budgetCardUsdCap', input.cardUsdCap);
    return { ok: true, value: { ok: true } };
  }

  /** Cost/usage rollup across this board's runs (docs/07 §6); `window` ("5h"/"7d") limits to recent spend. */
  async getUsage(opts?: { window?: string }): Promise<UsageSummary> {
    if (!opts?.window) return this.computeUsage();
    const ms = parseWindowMs(opts.window);
    const since = ms === null ? undefined : new Date(this.nowMs() - ms).toISOString();
    return this.computeUsage(since);
  }

  /**
   * In-app notifications for this board, newest first (docs/07 §7).
   *
   * `notifications.user_id` is written from the card owner and was never used as a filter, so
   * every board notification was returned to every caller. With one member per workspace that was
   * invisible; the moment a second person joins it is a disclosure — a notification body names a
   * card and says what happened to it.
   *
   * A null `user_id` is addressed to nobody in particular (work became available, a card was
   * refused at claim time) and reaches everyone. That is the design, not a gap: those are facts
   * about the board rather than about a person.
   *
   * An omitted `userId` keeps the unfiltered read, for internal callers that have no person to
   * filter by. Every route passes one.
   */
  async getNotifications(opts?: { unreadOnly?: boolean; userId?: string }): Promise<NotificationView[]> {
    const predicates: string[] = [];
    const params: unknown[] = [];
    if (opts?.unreadOnly) predicates.push('read = 0');
    if (opts?.userId !== undefined) {
      predicates.push('(user_id IS NULL OR user_id = ?)');
      params.push(opts.userId);
    }
    const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';
    return this.sql
      .exec(`SELECT * FROM notifications ${where} ORDER BY seq DESC LIMIT 200`, ...params)
      .toArray()
      .map((r) => ({
        seq: Number(r.seq),
        kind: r.kind as string,
        cardId: r.card_id as string,
        userId: (r.user_id as string | null) ?? null,
        body: r.body as string,
        read: Number(r.read) === 1,
        createdAt: r.created_at as string,
      }));
  }

  /** Mark a notification read (docs/07 §7). */
  async markNotificationRead(seq: number): Promise<Result<{ ok: true }>> {
    this.sql.exec(`UPDATE notifications SET read = 1 WHERE seq = ?`, seq);
    return { ok: true, value: { ok: true } };
  }

  /** Define or replace an agent profile by key (docs/05 §7). */
  async setProfile(input: ProfileInput): Promise<Result<{ key: string }>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    this.sql.exec(
      `INSERT INTO profiles (key, name, harness, model, permission_policy, autonomy_level, capabilities_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET name = excluded.name, harness = excluded.harness, model = excluded.model,
         permission_policy = excluded.permission_policy, autonomy_level = excluded.autonomy_level, capabilities_json = excluded.capabilities_json`,
      input.key,
      input.name ?? null,
      input.harness ?? null,
      input.model ?? null,
      input.permissionPolicy ?? null,
      input.autonomyLevel ?? null,
      JSON.stringify(input.capabilities ?? []),
      this.now(),
    );
    return { ok: true, value: { key: input.key } };
  }

  /** List the board's agent profiles (docs/05 §7). */
  async getProfiles(): Promise<ProfileView[]> {
    return this.sql
      .exec(`SELECT * FROM profiles ORDER BY key ASC`)
      .toArray()
      .map((r) => ({
        key: r.key as string,
        name: (r.name as string | null) ?? null,
        harness: (r.harness as string | null) ?? null,
        model: (r.model as string | null) ?? null,
        permissionPolicy: (r.permission_policy as string | null) ?? null,
        autonomyLevel: (r.autonomy_level as string | null) ?? null,
        capabilities: JSON.parse(r.capabilities_json as string) as string[],
      }));
  }

  /** Register/replace an agent's push subscription (docs/05 §4). Only http(s) urls (SSRF guard). */
  async registerPushConfig(input: PushConfigInput): Promise<Result<{ configId: string }>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    if (!isPublicHttpUrl(input.url)) {
      return { ok: false, code: 'INVALID_URL', message: `push url must be a public http(s) endpoint: ${input.url}` };
    }
    const existing = this.sql.exec(`SELECT id FROM push_configs WHERE agent_id = ? AND url = ?`, input.agentId, input.url).toArray()[0];
    const id = existing ? (existing.id as string) : newId('push');
    const caps = JSON.stringify(input.capabilities ?? []);
    const events = JSON.stringify(input.events ?? ['work.available']);
    if (existing) {
      this.sql.exec(`UPDATE push_configs SET token = ?, capabilities_json = ?, events_json = ? WHERE id = ?`, input.token, caps, events, id);
    } else {
      this.sql.exec(
        `INSERT INTO push_configs (id, agent_id, url, token, capabilities_json, events_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.agentId,
        input.url,
        input.token,
        caps,
        events,
        this.now(),
      );
    }
    return { ok: true, value: { configId: id } };
  }

  /** Inspect the push delivery queue (docs/05 §4). */
  async getPushDeliveries(opts?: { status?: string }): Promise<PushDeliveryView[]> {
    const where = opts?.status ? ` WHERE status = ?` : '';
    const p = opts?.status ? [opts.status] : [];
    return this.sql
      .exec(`SELECT * FROM push_deliveries${where} ORDER BY id DESC LIMIT 200`, ...p)
      .toArray()
      .reverse()
      .map((r) => ({
        id: Number(r.id),
        configId: r.config_id as string,
        url: r.url as string,
        body: r.body as string,
        status: r.status as string,
        attempts: Number(r.attempts),
      }));
  }

  /**
   * Drain pending push deliveries: sign each with its config token and send (docs/05 §4). The sender
   * is injectable (tests pass a stub); production durability — Queue + Workflow with exponential
   * backoff — wraps this. A single drain marks each delivery sent/failed.
   */
  async dispatchPushDeliveries(sender: PushSender = defaultPushSender): Promise<{ sent: number; failed: number }> {
    // Retry pending + previously-failed rows under the attempt cap; exhausted ones are dead-lettered.
    const rows = this.sql
      .exec(
        `SELECT d.id, d.url, d.body, d.attempts, c.token FROM push_deliveries d JOIN push_configs c ON d.config_id = c.id
         WHERE d.status IN ('pending', 'failed') AND d.attempts < ? ORDER BY d.id ASC LIMIT 50`,
        MAX_PUSH_ATTEMPTS,
      )
      .toArray();
    let sent = 0;
    let failed = 0;
    for (const r of rows) {
      const outcome = await signAndSend({ id: Number(r.id), url: r.url as string, body: r.body as string, token: r.token as string }, sender);
      const attempts = Number(r.attempts) + 1;
      const status = outcome.ok ? 'sent' : attempts >= MAX_PUSH_ATTEMPTS ? 'dead' : 'failed';
      this.sql.exec(`UPDATE push_deliveries SET status = ?, attempts = ?, last_status = ? WHERE id = ?`, status, attempts, outcome.status, r.id);
      if (outcome.ok) sent++;
      else failed++;
    }
    // Bound the queue: keep only the most recent terminal rows (sent + dead-lettered); pending/failed
    // (still-retrying) rows are always kept.
    this.sql.exec(
      `DELETE FROM push_deliveries WHERE status IN ('sent', 'dead') AND id NOT IN (SELECT id FROM push_deliveries WHERE status IN ('sent', 'dead') ORDER BY id DESC LIMIT 100)`,
    );
    return { sent, failed };
  }

  /**
   * Queue `work.available` deliveries for a claimable card, only to configs that could actually claim
   * it (docs/05 §4): a capability stage targets configs advertising that capability; an agent-owned
   * stage targets only that agent. No pings while the board is over budget (claim would refuse).
   */
  private notifyWorkAvailable(cardId: string): void {
    const card = this.getCard(cardId);
    if (!card || card.state !== 'submitted') return;
    if (this.boardOverBudget()) return;
    const stage = this.stages().find((s) => s.key === card.currentStageKey);
    if (!stage || !this.isAgentClaimable(stage)) return;
    const ownerCapability = stage.ownerKind === 'capability' ? stage.owner : undefined;
    const ownerAgent = stage.ownerKind === 'agent' ? stage.owner : undefined;
    const boardId = this.getMeta('boardId');
    const ts = this.now();
    for (const cfg of this.sql.exec(`SELECT * FROM push_configs`).toArray()) {
      const events = JSON.parse(cfg.events_json as string) as string[];
      if (!events.includes('work.available')) continue;
      if (ownerAgent && (cfg.agent_id as string) !== ownerAgent) continue;
      if (ownerCapability) {
        const caps = JSON.parse(cfg.capabilities_json as string) as string[];
        if (!caps.includes(ownerCapability)) continue;
      }
      const body = JSON.stringify({ event: 'work.available', boardId, cardId, stageKey: stage.key, ts });
      this.sql.exec(
        `INSERT INTO push_deliveries (config_id, url, body, status, attempts, created_at) VALUES (?, ?, ?, 'pending', 0, ?)`,
        cfg.id,
        cfg.url,
        body,
        ts,
      );
    }
  }

  /**
   * Pre-run cost estimate for a card's current stage (docs/07 §6): the average spend per **ended**
   * billed run at that stage. `status = 'ended'` excludes the card's own in-flight run (no
   * self-skew); the INNER join means `sampleSize` counts ended runs that actually reported usage.
   */
  async estimateCardCost(cardId: string): Promise<Result<EstimateView>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    const card = this.getCard(cardId);
    if (!card) return { ok: false, code: 'CARD_NOT_FOUND', message: `card not found: ${cardId}` };
    const stageKey = card.currentStageKey;
    const row = this.sql
      .exec(
        `SELECT COUNT(DISTINCT u.run_id) AS runs, COALESCE(SUM(u.cost_usd), 0) AS cost
         FROM usage_records u JOIN runs r ON u.run_id = r.id WHERE r.stage_key = ? AND r.status = 'ended'`,
        stageKey,
      )
      .one();
    const runs = Number(row.runs);
    return { ok: true, value: { stageKey, estimatedUsd: runs > 0 ? Number(row.cost) / runs : null, sampleSize: runs } };
  }

  /** A card's session replay: its durable activity waterfall + the handoff carried into it (docs/07 §4). */
  async getCardActivities(cardId: string): Promise<{ activities: ActivityView[]; handoff: JsonValue | null; gates: GateView[] }> {
    const activities = this.sql
      .exec(`SELECT * FROM activities WHERE card_id = ? AND ephemeral = 0 ORDER BY seq ASC`, cardId)
      .toArray()
      .map((r) => {
        const detail = (r.detail_json ? JSON.parse(r.detail_json as string) : {}) as {
          parameter?: JsonValue;
          result?: JsonValue;
          signal?: string;
        };
        return {
          seq: Number(r.seq),
          runId: r.run_id as string,
          type: r.type as string,
          ts: r.ts as string,
          body: (r.body as string | null) ?? null,
          action: (r.action as string | null) ?? null,
          parameter: detail.parameter ?? null,
          result: detail.result ?? null,
          signal: detail.signal ?? null,
        };
      });
    // Gates ride along with the timeline rather than getting their own route: "who approved this
    // and what did they say" is a question about the card's history, which is what this endpoint
    // already answers.
    return { activities, handoff: this.parseHandoff(this.getCardHandoffJson(cardId)), gates: this.gatesForCard(cardId) };
  }

  /** How many cards are ready (submitted) in stages these capabilities can claim — for work discovery. */
  async countReadyForCapabilities(agentId: string, capabilities: string[]): Promise<number> {
    if (!this.getMeta('boardId')) return 0;
    const claimableKeys = this.stages()
      .filter((s) => this.stageMatches(s, agentId, capabilities))
      .map((s) => s.key);
    if (claimableKeys.length === 0) return 0;
    const placeholders = claimableKeys.map(() => '?').join(', ');
    return Number(
      this.sql
        .exec(`SELECT COUNT(*) AS n FROM cards WHERE state = 'submitted' AND current_stage_key IN (${placeholders})`, ...claimableKeys)
        .one().n,
    );
  }

  /**
   * The agent read surface (docs/04 §3 `getCard`): everything the agent that owns `runId` needs to
   * work its card, and nothing else. Authorized by the same predicate as the run verbs — a run
   * belongs to the agent that claimed it — so there is one ownership rule, not two.
   *
   * Unlike the verbs this does not require a live lease: a finished run stays readable so an agent
   * can verify the outcome it produced (and a reclaimed one can see that it lost the card).
   */
  async getRunContext(input: { runId: string; agentId?: string | null }): Promise<Result<RunContext>> {
    const row = this.getRunRow(input.runId);
    if (!row) return { ok: false, code: 'RUN_NOT_FOUND', message: `run not found: ${input.runId}` };
    const denied = this.denyForeignRun(row, input.agentId);
    if (denied) return denied;

    const cardId = row.card_id as string;
    const card = this.getCard(cardId);
    if (!card) return { ok: false, code: 'CARD_NOT_FOUND', message: `card not found: ${cardId}` };
    return {
      ok: true,
      value: {
        run: {
          runId: row.id as string,
          cardId,
          stageKey: row.stage_key as string,
          leaseEpoch: Number(row.lease_epoch),
          status: row.status as string,
          outcome: (row.outcome as string | null) ?? null,
          startedAt: row.started_at as string,
          endedAt: (row.ended_at as string | null) ?? null,
        },
        card,
        stage: this.stages().find((s) => s.key === card.currentStageKey) ?? null,
        handoff: this.parseHandoff(this.getCardHandoffJson(cardId)),
        references: this.sql
          .exec(`SELECT * FROM card_references WHERE card_id = ? ORDER BY created_at ASC`, cardId)
          .toArray()
          .map((r) => this.rowToReference(r)),
        elicitations: this.elicitationsForRun(input.runId),
      },
    };
  }

  /** The attempts (runs) for a card, newest-stage-first, with each run's cost and model (docs/07 §5). */
  async getAttempts(cardId: string): Promise<AttemptView[]> {
    return this.sql
      .exec(`SELECT * FROM runs WHERE card_id = ? ORDER BY started_at ASC`, cardId)
      .toArray()
      .map((r) => {
        const runId = r.id as string;
        const cost = Number(this.sql.exec(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage_records WHERE run_id = ?`, runId).one().c);
        const modelRow = this.sql
          .exec(`SELECT model FROM usage_records WHERE run_id = ? AND model IS NOT NULL ORDER BY seq DESC LIMIT 1`, runId)
          .toArray()[0];
        return {
          runId,
          cardId: r.card_id as string,
          stageKey: r.stage_key as string,
          agentId: r.agent_id as string,
          status: r.status as string,
          outcome: (r.outcome as string | null) ?? null,
          startedAt: r.started_at as string,
          endedAt: (r.ended_at as string | null) ?? null,
          costUsd: cost,
          model: modelRow ? (modelRow.model as string) : null,
          profileKey: (r.profile_key as string | null) ?? null,
        };
      });
  }

  // ----- RPC: agent contract (docs/04) -----

  /**
   * The suite principal id this local agent maps to (`agents.external_id`), or `null` if it has
   * never been linked to one. A grant enumerates principal ids
   * (charter decisions/2026-08-30-an-agent-is-a-principal.md §3/§5), not kaambaan's local
   * `agt_…` ids — no external token has ever heard of the latter — so this is the id
   * `grantPermitsAgent` actually needs to compare against.
   */
  private async principalIdFor(agentId: string): Promise<string | null> {
    const row = await this.env.DB.prepare(`SELECT external_id FROM agents WHERE id = ?`)
      .bind(agentId)
      .first<{ external_id: string | null }>();
    return row?.external_id ?? null;
  }

  /**
   * Atomically hand a ready, capability-matched card to an agent, within its concurrency limit.
   *
   * `principalId` is the caller's already-resolved suite principal id (`agents.external_id`),
   * when the auth path that authenticated this request already fetched it — a `kbn_` token does,
   * off the same catalog row that resolves the token (`findAgentByTokenHash`). Passing it here
   * skips the extra `SELECT` `principalIdFor` would otherwise issue on every enforced claim, which
   * matters because this is the path every agent hits repeatedly. `undefined` (not passed at all)
   * means the caller never resolved it — the dev-header auth path, which carries no DB-backed
   * identity — and this method falls back to looking it up itself, exactly as before.
   */
  async claim(input: {
    agentId: string;
    capabilities: string[];
    maxConcurrency?: number;
    profileKey?: string;
    principalId?: string | null;
  }): Promise<ClaimResult> {
    if (!this.getMeta('boardId')) return { claimed: false };
    // Budget cap (docs/07 §6): once the board hits its USD ceiling, stop handing out new work.
    if (this.boardOverBudget()) return { claimed: false };
    const max = input.maxConcurrency ?? 1;
    const active = Number(
      this.sql.exec(`SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status = 'working'`, input.agentId).one().n,
    );
    if (active >= max) return { claimed: false };

    const claimableKeys = this.stages()
      .filter((s) => this.stageMatches(s, input.agentId, input.capabilities))
      .map((s) => s.key);
    if (claimableKeys.length === 0) return { claimed: false };

    const placeholders = claimableKeys.map(() => '?').join(', ');
    const row = this.sql
      .exec(
        `SELECT * FROM cards WHERE state = 'submitted' AND current_stage_key IN (${placeholders})
         ORDER BY priority DESC, created_at ASC LIMIT 1`,
        ...claimableKeys,
      )
      .toArray()[0];
    if (!row) return { claimed: false };

    // ── The control pair, at the moment the work is handed out ──────────────
    //
    // The card records what its queuer was PERMITTED to dispatch
    // (charter decisions/2026-08-13-ecosystem-identity.md, Decision 4). The
    // human is long gone by now, which is exactly why the answer was written
    // down when it was still askable.
    //
    // A refusal is made VISIBLE rather than skipped. Silently passing over the
    // card would leave a board that looks idle while work sits on it — the
    // decision requires a denial to be reported, never dropped — so the card is
    // parked in `input-required`, which is this board's existing way of saying a
    // person has to do something. That also bounds the noise: the card leaves
    // `submitted`, so this is evaluated once and not on every poll.
    if (isControlPairEnforced(this.env)) {
      const grant = row.queued_grant ? (JSON.parse(row.queued_grant as string) as string[]) : null;
      const principalId = input.principalId !== undefined ? input.principalId : await this.principalIdFor(input.agentId);
      if (!grantPermitsAgent(grant, principalId)) {
        const why = grant
          ? `the operator who queued this card may not dispatch ${input.agentId}`
          : 'this card was queued without an authorising token, so no one with permission asked for it to run';
        this.sql.exec(
          `UPDATE cards SET state = 'input-required', updated_at = ? WHERE id = ?`,
          this.now(),
          row.id as string,
        );
        this.notify('control-pair', row.id as string, `Not dispatched: ${why}`);
        this.emit('card.blocked', { cardId: row.id as string, reason: why });
        return { claimed: false };
      }
    }

    const card = this.rowToCard(row);
    const leaseEpoch = Number(row.claim_seq) + 1;
    const runId = newId('run');
    const now = this.now();
    const nowMs = this.nowMs();
    this.sql.exec(
      `INSERT INTO runs (id, card_id, stage_key, agent_id, lease_epoch, status, outcome, last_heartbeat_ms, started_at, ended_at, profile_key, queued_by)
       VALUES (?, ?, ?, ?, ?, 'working', NULL, ?, ?, NULL, ?, ?)`,
      runId,
      card.id,
      card.currentStageKey,
      input.agentId,
      leaseEpoch,
      nowMs,
      now,
      input.profileKey ?? null,
      // Pinned onto the attempt so a run records WHOSE work it was, and stays
      // answerable after the card has moved on.
      (row.queued_by as string | null) ?? null,
    );
    this.sql.exec(
      `UPDATE cards SET state = 'working', delegate_agent_id = ?, current_run_id = ?, claim_seq = ?, updated_at = ? WHERE id = ?`,
      input.agentId,
      runId,
      leaseEpoch,
      now,
      card.id,
    );
    this.emit('card.claimed', { cardId: card.id, agentId: input.agentId, runId });
    await this.scheduleReclaim();

    const stage = this.stages().find((s) => s.key === card.currentStageKey)!;
    const handoff = row.handoff_json ? (JSON.parse(row.handoff_json as string) as JsonValue) : null;
    return { claimed: true, runId, leaseEpoch, card: this.mustGetCard(card.id), stage, handoff };
  }

  async heartbeat(input: RunVerbInput): Promise<Result<{ acknowledged: true }>> {
    const auth = this.authorizeRun(input);
    if (!auth.ok) return auth;
    const run = auth.run;
    this.sql.exec(`UPDATE runs SET last_heartbeat_ms = ? WHERE id = ?`, this.nowMs(), input.runId);
    await this.scheduleReclaim();
    return { ok: true, value: { acknowledged: true } };
  }

  async postActivity(input: AgentActivityInput): Promise<Result<{ accepted: true; cardState: TaskState }>> {
    const auth = this.authorizeRun(input);
    if (!auth.ok) return auth;
    const run = auth.run;
    const cardId = run.card_id as string;
    if (input.usage) {
      // Validate at the DO so every wire (REST + MCP) shares the guarantee — a negative/NaN cost
      // would otherwise poison the SUMs the budget gate relies on.
      const { inputTokens, outputTokens, costUsd } = input.usage;
      const bad = [inputTokens, outputTokens, costUsd].some((n) => n !== undefined && (!Number.isFinite(n) || (n as number) < 0));
      if (bad) return { ok: false, code: 'INVALID_USAGE', message: 'usage tokens/cost must be finite and non-negative' };
      // Budget enforcement (docs/07 §6): once a cap is hit, reject further billable activities so an
      // in-flight run can't blow past the ceiling — overrun is bounded to the single crossing activity.
      const cardCap = this.budgetCap('budgetCardUsdCap');
      if (this.boardOverBudget() || (cardCap !== null && this.cardCost(cardId) >= cardCap)) {
        return { ok: false, code: 'BUDGET_EXCEEDED', message: 'budget cap reached for this board/card' };
      }
    }
    const now = this.now();
    const detail = JSON.stringify({
      parameter: input.parameter ?? null,
      result: input.result ?? null,
      signal: input.signal ?? null,
    });
    this.sql.exec(
      `INSERT INTO activities (run_id, card_id, type, ephemeral, body, action, detail_json, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.runId,
      cardId,
      input.type,
      input.ephemeral ? 1 : 0,
      input.body ?? null,
      input.action ?? null,
      detail,
      now,
    );
    // Metering (docs/07 §6): record token/cost usage, estimating cost when the agent doesn't report
    // it. Recorded even for ephemeral activities — an ephemeral "thinking" step still burned tokens.
    if (input.usage) {
      const u = input.usage;
      const reported = u.costUsd !== undefined;
      const cost = reported ? u.costUsd! : estimateCostUsd(u);
      this.sql.exec(
        `INSERT INTO usage_records (run_id, card_id, agent_id, model, input_tokens, output_tokens, cost_usd, estimated, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.runId,
        cardId,
        run.agent_id as string,
        u.model ?? null,
        u.inputTokens ?? 0,
        u.outputTokens ?? 0,
        cost,
        reported ? 0 : 1,
        now,
      );
    }
    // An activity is also a sign of life — it keeps the lease fresh.
    this.sql.exec(`UPDATE runs SET last_heartbeat_ms = ? WHERE id = ?`, this.nowMs(), input.runId);
    let cardState: TaskState = 'working';
    if (input.type === 'elicitation') {
      cardState = input.signal === 'auth' ? 'auth-required' : 'input-required';
      this.sql.exec(`UPDATE cards SET state = ?, updated_at = ? WHERE id = ?`, cardState, now, cardId);
      this.openElicitation(input, run, cardId, now);
    }
    this.emit('activity', { runId: input.runId, cardId, activityType: input.type });
    await this.scheduleReclaim();
    return { ok: true, value: { accepted: true, cardState } };
  }

  /** Finish a stage successfully, store the handoff, and advance the card (or mark it done). */
  async complete(input: RunVerbInput & { handoff?: JsonValue }): Promise<Result<CardView>> {
    const auth = this.authorizeRun(input);
    if (!auth.ok) return auth;
    const run = auth.run;
    const cardId = run.card_id as string;
    const now = this.now();
    this.sql.exec(`UPDATE runs SET status = 'ended', outcome = 'completed', ended_at = ? WHERE id = ?`, now, input.runId);
    this.cancelElicitationsForRun(input.runId);

    const card = this.mustGetCard(cardId);
    const handoffJson = input.handoff !== undefined ? JSON.stringify(input.handoff) : null;
    this.advanceCard(cardId, card.currentStageKey, run.agent_id as string, handoffJson);
    await this.scheduleReclaim();
    return { ok: true, value: this.mustGetCard(cardId) };
  }

  /** Submit a gated, agent-worked stage for human approval (docs/04, docs/08 §6). */
  async submitForReview(input: RunVerbInput & { output?: JsonValue }): Promise<Result<CardView>> {
    const auth = this.authorizeRun(input);
    if (!auth.ok) return auth;
    const run = auth.run;
    const cardId = run.card_id as string;
    const now = this.now();
    this.sql.exec(`UPDATE runs SET status = 'ended', outcome = 'submitted', ended_at = ? WHERE id = ?`, now, input.runId);
    this.cancelElicitationsForRun(input.runId);
    const card = this.mustGetCard(cardId);
    this.sql.exec(
      `UPDATE cards SET state = 'input-required', delegate_agent_id = NULL, current_run_id = NULL, updated_at = ? WHERE id = ?`,
      now,
      cardId,
    );
    // request_changes returns to the same (worked) stage so the agent can redo it.
    this.createGate(cardId, card.currentStageKey, card.currentStageKey, run.agent_id as string);
    await this.scheduleReclaim();
    return { ok: true, value: this.mustGetCard(cardId) };
  }

  /** Resolve a pending approval gate (docs/08 §6). Enforces separation of duties. */
  async resolveGate(input: {
    gateId: string;
    decision: GateDecision;
    decidedBy: string;
    comment?: string;
  }): Promise<Result<CardView>> {
    const gate = this.sql.exec(`SELECT * FROM gates WHERE id = ?`, input.gateId).toArray()[0];
    if (!gate) return { ok: false, code: 'GATE_NOT_FOUND', message: `gate not found: ${input.gateId}` };
    if ((gate.status as string) !== 'pending') {
      return { ok: false, code: 'GATE_NOT_PENDING', message: 'gate is already resolved' };
    }
    if (input.decidedBy === (gate.produced_by as string)) {
      return { ok: false, code: 'SEPARATION_OF_DUTIES', message: 'the producer cannot resolve their own gate' };
    }
    const cardId = gate.card_id as string;
    const now = this.now();
    this.sql.exec(
      `UPDATE gates SET status = 'resolved', decision = ?, comment = ?, decided_by = ?, resolved_at = ? WHERE id = ?`,
      input.decision,
      input.comment ?? null,
      input.decidedBy,
      now,
      input.gateId,
    );
    if (input.decision === 'approve') {
      // The approver becomes the producer of any chained gate (keeps separation-of-duties intact).
      this.advanceCard(cardId, gate.stage_key as string, input.decidedBy, this.getCardHandoffJson(cardId));
    } else if (input.decision === 'request_changes') {
      // Keep the agent's prior handoff and add the reviewer's feedback so rework has full context.
      const prior = this.parseHandoff(this.getCardHandoffJson(cardId));
      const merged =
        prior && typeof prior === 'object' && !Array.isArray(prior)
          ? { ...prior, feedback: input.comment ?? null }
          : { feedback: input.comment ?? null };
      this.sql.exec(
        `UPDATE cards SET current_stage_key = ?, state = 'submitted', delegate_agent_id = NULL,
         current_run_id = NULL, failure_count = 0, handoff_json = ?, updated_at = ? WHERE id = ?`,
        gate.return_stage_key,
        JSON.stringify(merged),
        now,
        cardId,
      );
      this.emit('card.changes_requested', { cardId, gateId: input.gateId, to: gate.return_stage_key });
      this.notifyWorkAvailable(cardId); // back on a claimable stage for rework
    } else {
      this.sql.exec(
        `UPDATE cards SET state = 'rejected', delegate_agent_id = NULL, current_run_id = NULL, updated_at = ? WHERE id = ?`,
        now,
        cardId,
      );
      this.emit('card.rejected', { cardId, gateId: input.gateId });
    }
    this.emit('gate.resolved', { gateId: input.gateId, cardId, decision: input.decision, decidedBy: input.decidedBy });
    return { ok: true, value: this.mustGetCard(cardId) };
  }

  /**
   * Answer an agent's question (docs/04 §4) — the human half of the elicitation return path.
   *
   * Authorization has two halves and both matter. The **edge** only exposes this to a human
   * principal (a session; agent tokens reach `claims` and `runs/*` and nothing else). Here, where
   * every surface must pass, the **asking agent is refused by identity**: an elicitation an agent
   * can answer itself is decorative, and this is the same separation-of-duties rule `resolveGate`
   * already enforces for the producer of a gate.
   *
   * The card moves through the **state machine's own** transition — `human_reply` out of
   * `input-required`, `account_linked` out of `auth-required` — rather than a second, parallel
   * path: if the contract stops allowing it, this stops doing it.
   *
   * Answering a settled question is a typed conflict, never a second transition, so a double-click
   * (or a retried delivery) cannot move a card twice.
   */
  async answerElicitation(input: {
    elicitationId: string;
    answeredBy: string;
    option?: string;
    text?: string;
  }): Promise<Result<{ card: CardView; elicitation: ElicitationView }>> {
    const row = this.sql.exec(`SELECT * FROM elicitations WHERE id = ?`, input.elicitationId).toArray()[0];
    if (!row) {
      return { ok: false, code: 'ELICITATION_NOT_FOUND', message: `elicitation not found: ${input.elicitationId}` };
    }
    const elicitation = this.rowToElicitation(row);
    if (elicitation.status !== 'pending') {
      return {
        ok: false,
        code: 'ELICITATION_NOT_PENDING',
        message: `this question is already ${elicitation.status}`,
      };
    }
    if (input.answeredBy === elicitation.agentId) {
      return { ok: false, code: 'SEPARATION_OF_DUTIES', message: 'the agent that asked cannot answer its own question' };
    }
    const card = this.getCard(elicitation.cardId);
    if (!card) return { ok: false, code: 'CARD_NOT_FOUND', message: `card not found: ${elicitation.cardId}` };

    const text = input.text?.trim() ?? '';
    const option = input.option?.trim() ?? '';
    if (option !== '' && !elicitation.options.some((o) => o.name === option)) {
      return { ok: false, code: 'INVALID_ANSWER', message: `"${option}" is not one of the offered options` };
    }
    if (option === '' && text === '') {
      return {
        ok: false,
        code: 'INVALID_ANSWER',
        message: elicitation.options.length > 0 ? 'pick one of the offered options' : 'an answer needs some text',
      };
    }

    // The card must still be waiting on this answer, and it moves by the contract's transition.
    const event: TaskEventType = card.state === 'auth-required' ? 'account_linked' : 'human_reply';
    if (!canTransition(card.state, event)) {
      return { ok: false, code: 'CARD_NOT_WAITING', message: `a card in "${card.state}" is not waiting on an answer` };
    }
    const resumed = nextState(card.state, event);

    const now = this.now();
    this.sql.exec(
      `UPDATE elicitations SET status = 'answered', answer_option = ?, answer_text = ?, answered_by = ?, answered_at = ? WHERE id = ?`,
      option === '' ? null : option,
      text === '' ? null : text,
      input.answeredBy,
      now,
      elicitation.id,
    );
    this.sql.exec(`UPDATE cards SET state = ?, updated_at = ? WHERE id = ?`, resumed, now, card.id);

    // The answer joins the card's replay as a `prompt` — the human-authored activity type, which is
    // exactly what "resumes working" means in the activity vocabulary (docs/04 §4).
    const chosen = elicitation.options.find((o) => o.name === option);
    const body = [chosen?.title ?? option, text].filter((s) => s !== '' && s !== undefined).join(' — ');
    this.sql.exec(
      `INSERT INTO activities (run_id, card_id, type, ephemeral, body, action, detail_json, ts)
       VALUES (?, ?, 'prompt', 0, ?, NULL, ?, ?)`,
      elicitation.runId,
      card.id,
      body,
      JSON.stringify({
        parameter: { elicitationId: elicitation.id, option: option === '' ? null : option },
        result: null,
        signal: null,
      }),
      now,
    );
    this.emit('elicitation.answered', {
      elicitationId: elicitation.id,
      cardId: card.id,
      runId: elicitation.runId,
      option: option === '' ? null : option,
      answeredBy: input.answeredBy,
    });
    return {
      ok: true,
      value: { card: this.mustGetCard(card.id), elicitation: this.mustGetElicitation(elicitation.id) },
    };
  }

  /** Escalate to a human — the card parks in input-required (docs/08 §6 — gates resolve in P3). */
  async block(input: RunVerbInput & { reason: string }): Promise<Result<CardView>> {
    const auth = this.authorizeRun(input);
    if (!auth.ok) return auth;
    const run = auth.run;
    const cardId = run.card_id as string;
    const now = this.now();
    this.sql.exec(`UPDATE runs SET status = 'ended', outcome = 'blocked', ended_at = ? WHERE id = ?`, now, input.runId);
    this.cancelElicitationsForRun(input.runId);
    this.sql.exec(
      `UPDATE cards SET state = 'input-required', delegate_agent_id = NULL, current_run_id = NULL, updated_at = ? WHERE id = ?`,
      now,
      cardId,
    );
    this.emit('card.blocked', { cardId, reason: input.reason });
    await this.scheduleReclaim();
    return { ok: true, value: this.mustGetCard(cardId) };
  }

  /** Report a failure — retryable until the circuit breaker trips (docs/08 §4). */
  async fail(input: RunVerbInput & { reason: string }): Promise<Result<CardView>> {
    const auth = this.authorizeRun(input);
    if (!auth.ok) return auth;
    const run = auth.run;
    const cardId = run.card_id as string;
    this.sql.exec(`UPDATE runs SET status = 'ended', outcome = 'crashed', ended_at = ? WHERE id = ?`, this.now(), input.runId);
    this.cancelElicitationsForRun(input.runId);
    this.endAttempt(cardId, 'card.failed', input.reason);
    this.notify('failed', cardId, input.reason || 'Run failed');
    return { ok: true, value: this.mustGetCard(cardId) };
  }

  /** Give the claim back without penalty — the card becomes claimable again (docs/04). */
  async release(input: RunVerbInput & { reason?: string }): Promise<Result<CardView>> {
    const auth = this.authorizeRun(input);
    if (!auth.ok) return auth;
    const run = auth.run;
    const cardId = run.card_id as string;
    const now = this.now();
    this.sql.exec(`UPDATE runs SET status = 'ended', outcome = 'released', ended_at = ? WHERE id = ?`, now, input.runId);
    this.cancelElicitationsForRun(input.runId);
    this.sql.exec(
      `UPDATE cards SET state = 'submitted', delegate_agent_id = NULL, current_run_id = NULL, updated_at = ? WHERE id = ?`,
      now,
      cardId,
    );
    this.emit('run.released', { cardId, runId: input.runId });
    this.notifyWorkAvailable(cardId);
    await this.scheduleReclaim();
    return { ok: true, value: this.mustGetCard(cardId) };
  }

  /**
   * Reclaim runs whose heartbeat lapsed by `nowMs` (Temporal-style heartbeat timeout, docs/08 §3).
   * Time is a parameter so the alarm passes `Date.now()` while tests pass a chosen instant.
   */
  reclaimExpired(nowMs: number): number {
    const rows = this.sql
      .exec(
        `SELECT id, card_id FROM runs WHERE status = 'working' AND (last_heartbeat_ms + ?) <= ?`,
        HEARTBEAT_TIMEOUT_MS,
        nowMs,
      )
      .toArray();
    const now = this.now();
    for (const r of rows) {
      this.sql.exec(`UPDATE runs SET status = 'ended', outcome = 'reclaimed', ended_at = ? WHERE id = ?`, now, r.id);
      this.cancelElicitationsForRun(r.id as string);
      this.endAttempt(r.card_id as string, 'run.reclaimed', null, String(r.id)); // endAttempt re-queues + notifies work.available
      this.notify('reclaimed', r.card_id as string, 'Agent went dark — run reclaimed');
    }
    return rows.length;
  }

  // ----- WebSocket hub (hibernatable) -----

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ kind: 'snapshot', state: this.snapshot() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // The board is read-only over WebSocket; mutations go through the REST/RPC verbs.
  }

  webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): void {
    try {
      ws.close(code);
    } catch {
      // already closed
    }
  }

  /** DO alarm: reclaim lapsed runs, then re-arm for the next-earliest heartbeat deadline. */
  async alarm(): Promise<void> {
    this.reclaimExpired(this.nowMs());
    // The queue's only unattended drain. See PUSH_DRAIN_BASE_MS for what this
    // fixes; `scheduleReclaim` below is what brings the alarm back while
    // anything is still pending.
    await this.dispatchPushDeliveries();
    await this.scheduleReclaim();
  }

  // ----- internals -----

  /** End the current attempt on a card: bump failures and either re-queue or trip the breaker. */
  private endAttempt(cardId: string, event: string, reason: string | null, runId?: string): void {
    const cardRow = this.getCardRow(cardId);
    if (!cardRow) return;
    const failures = Number(cardRow.failure_count) + 1;
    const state: TaskState = failures >= CIRCUIT_BREAKER_LIMIT ? 'input-required' : 'submitted';
    const now = this.now();
    this.sql.exec(
      `UPDATE cards SET state = ?, delegate_agent_id = NULL, current_run_id = NULL, failure_count = ?, updated_at = ? WHERE id = ?`,
      state,
      failures,
      now,
      cardId,
    );
    this.emit(event, { cardId, runId: runId ?? null, reason, failures, brokeCircuit: state === 'input-required' });
    // Central re-queue point (fail + reclaim): a card returned to the queue is claimable again.
    this.notifyWorkAvailable(cardId);
  }

  /** Advance a card to the next stage — opening an approval gate on entry to a human review stage. */
  private advanceCard(cardId: string, fromStageKey: string, producedBy: string, handoffJson: string | null): void {
    const stages = this.stages();
    const idx = stages.findIndex((s) => s.key === fromStageKey);
    if (idx === -1) return; // unknown stage — never silently advance to stage[0]
    const next = stages[idx + 1];
    const now = this.now();
    if (!next) {
      this.sql.exec(
        `UPDATE cards SET state = 'completed', delegate_agent_id = NULL, current_run_id = NULL, failure_count = 0, handoff_json = ?, updated_at = ? WHERE id = ?`,
        handoffJson,
        now,
        cardId,
      );
      this.emit('card.completed', { cardId });
      return;
    }
    const gated = next.gate === 'approval' && !this.isAgentClaimable(next);
    this.sql.exec(
      `UPDATE cards SET current_stage_key = ?, state = ?, delegate_agent_id = NULL, current_run_id = NULL, failure_count = 0, handoff_json = ?, updated_at = ? WHERE id = ?`,
      next.key,
      gated ? 'input-required' : 'submitted',
      handoffJson,
      now,
      cardId,
    );
    this.emit('card.advanced', { cardId, from: fromStageKey, to: next.key });
    if (gated) this.createGate(cardId, next.key, fromStageKey, producedBy);
    else this.notifyWorkAvailable(cardId);
  }

  private createGate(cardId: string, stageKey: string, returnStageKey: string, producedBy: string): string {
    const id = newId('gate');
    const now = this.now();
    this.sql.exec(
      `INSERT INTO gates (id, card_id, stage_key, return_stage_key, status, produced_by, options_json, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      id,
      cardId,
      stageKey,
      returnStageKey,
      producedBy,
      JSON.stringify(DEFAULT_GATE_OPTIONS),
      now,
    );
    this.emit('gate.opened', { gateId: id, cardId, stageKey });
    this.notify('gate', cardId, `Review needed at ${stageKey}`);
    this.notifyGatePending(id);
    return id;
  }

  /**
   * Persist the question an agent just asked, so a human has something to answer (docs/04 §4).
   * The card can only be waiting on one thing at a time, so a new question supersedes any earlier
   * pending one on the same card — the agent is blocked on its latest ask, and a superseded question
   * is no longer answerable rather than lingering as a prompt nobody can act on.
   */
  private openElicitation(input: AgentActivityInput, run: Row, cardId: string, now: string): void {
    this.cancelElicitationsForCard(cardId);
    const id = newId('elc');
    const question = input.body ?? '';
    this.sql.exec(
      `INSERT INTO elicitations
        (id, card_id, run_id, stage_key, agent_id, question, signal, options_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      cardId,
      input.runId,
      run.stage_key as string,
      run.agent_id as string,
      question,
      input.signal ?? null,
      JSON.stringify(parseElicitationOptions(input.parameter)),
      now,
    );
    this.emit('elicitation.opened', { elicitationId: id, cardId, runId: input.runId, signal: input.signal ?? null });
    this.notify('input', cardId, question === '' ? 'An agent is waiting on you' : question);
  }

  /**
   * Retire questions nobody can usefully answer any more. A pending elicitation belongs to a live
   * run and a waiting card; once either is gone (the run ended or was reclaimed, the card was moved
   * away, a newer question superseded it) the prompt would otherwise sit in the board's "needs you"
   * queue forever, and answering it would transition a card that has already moved on.
   */
  private cancelElicitationsForRun(runId: string): void {
    this.sql.exec(
      `UPDATE elicitations SET status = 'cancelled', answered_at = ? WHERE status = 'pending' AND run_id = ?`,
      this.now(),
      runId,
    );
  }

  /** As above, for every run on a card — the card itself has stopped waiting. */
  private cancelElicitationsForCard(cardId: string): void {
    this.sql.exec(
      `UPDATE elicitations SET status = 'cancelled', answered_at = ? WHERE status = 'pending' AND card_id = ?`,
      this.now(),
      cardId,
    );
  }

  private rowToElicitation(row: Row): ElicitationView {
    const answeredBy = (row.answered_by as string | null) ?? null;
    return {
      id: row.id as string,
      cardId: row.card_id as string,
      runId: row.run_id as string,
      stageKey: row.stage_key as string,
      agentId: row.agent_id as string,
      question: row.question as string,
      signal: (row.signal as string | null) ?? null,
      options: JSON.parse(row.options_json as string) as GateOption[],
      status: row.status as ElicitationStatus,
      answer:
        row.status === 'answered' && answeredBy
          ? {
              option: (row.answer_option as string | null) ?? null,
              text: (row.answer_text as string | null) ?? null,
              answeredBy,
              answeredAt: (row.answered_at as string | null) ?? '',
            }
          : null,
      createdAt: row.created_at as string,
    };
  }

  private mustGetElicitation(id: string): ElicitationView {
    const row = this.sql.exec(`SELECT * FROM elicitations WHERE id = ?`, id).toArray()[0];
    if (!row) throw new Error(`invariant violation: elicitation ${id} missing immediately after write`);
    return this.rowToElicitation(row);
  }

  /** Every question a run asked, oldest first — the agent read surface's view (docs/04 §3). */
  private elicitationsForRun(runId: string): ElicitationView[] {
    return this.sql
      .exec(`SELECT * FROM elicitations WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`, runId)
      .toArray()
      .map((r) => this.rowToElicitation(r));
  }

  /** Every question currently waiting on a human, board-wide — the human's view. */
  private pendingElicitations(): ElicitationView[] {
    return this.sql
      .exec(`SELECT * FROM elicitations WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC`)
      .toArray()
      .map((r) => this.rowToElicitation(r));
  }

  private isAgentClaimable(stage: StageDef): boolean {
    return stage.ownerKind === 'capability' || stage.ownerKind === 'agent';
  }

  private getCardHandoffJson(cardId: string): string | null {
    const row = this.getCardRow(cardId);
    return row ? ((row.handoff_json as string | null) ?? null) : null;
  }

  private parseHandoff(raw: string | null): JsonValue | null {
    return raw ? (JSON.parse(raw) as JsonValue) : null;
  }

  private pendingGates(): GateView[] {
    return this.sql
      .exec(`SELECT * FROM gates WHERE status = 'pending' ORDER BY created_at ASC`)
      .toArray()
      .map((r) => ({
        id: r.id as string,
        cardId: r.card_id as string,
        stageKey: r.stage_key as string,
        status: r.status as 'pending' | 'resolved',
        decision: (r.decision as string | null) ?? null,
        options: JSON.parse(r.options_json as string) as GateOption[],
        producedBy: r.produced_by as string,
        createdAt: r.created_at as string,
        decidedBy: (r.decided_by as string | null) ?? null,
        comment: (r.comment as string | null) ?? null,
        resolvedAt: (r.resolved_at as string | null) ?? null,
      }));
  }

  /**
   * Every gate on a card, decided ones included.
   *
   * `pendingGates` above answers "what is waiting on a human right now" and is what the board
   * snapshot carries. This answers "what was decided on this card, by whom, and with what
   * comment" — a question `gates.decided_by` and `gates.comment` could always have answered and
   * no read shape ever asked.
   */
  private gatesForCard(cardId: string): GateView[] {
    return this.sql
      .exec(`SELECT * FROM gates WHERE card_id = ? ORDER BY created_at ASC`, cardId)
      .toArray()
      .map((r) => ({
        id: r.id as string,
        cardId: r.card_id as string,
        stageKey: r.stage_key as string,
        status: r.status as 'pending' | 'resolved',
        decision: (r.decision as string | null) ?? null,
        options: JSON.parse(r.options_json as string) as GateOption[],
        producedBy: r.produced_by as string,
        createdAt: r.created_at as string,
        decidedBy: (r.decided_by as string | null) ?? null,
        comment: (r.comment as string | null) ?? null,
        resolvedAt: (r.resolved_at as string | null) ?? null,
      }));
  }

  private stageMatches(stage: StageDef, agentId: string, capabilities: string[]): boolean {
    if (stage.ownerKind === 'agent') return stage.owner === agentId;
    if (stage.ownerKind === 'capability') return stage.owner !== undefined && capabilities.includes(stage.owner);
    return false;
  }

  private getRunRow(runId: string): Row | null {
    return this.sql.exec(`SELECT * FROM runs WHERE id = ?`, runId).toArray()[0] ?? null;
  }

  /**
   * The gate every run verb passes: the run must **belong to the calling agent** and hold a **live
   * lease**. Both checks live here so a new verb cannot forget one.
   *
   * Identity is checked first: an agent that does not own the run learns nothing about its lease,
   * and — more importantly — a `NOT_RUN_OWNER` is never confused with the `STALE_LEASE` that tells
   * a well-behaved agent to re-claim.
   *
   * The lease is unchanged and still authoritative: fencing (epoch) and reclaim (status) refuse the
   * owning agent exactly as before. This is an additional check, not a replacement.
   */
  private authorizeRun(input: { runId: string; leaseEpoch: number; agentId?: string | null }): RunAuth {
    const row = this.getRunRow(input.runId);
    if (row) {
      const denied = this.denyForeignRun(row, input.agentId);
      if (denied) return denied;
    }
    if (!row || (row.status as string) !== 'working' || Number(row.lease_epoch) !== input.leaseEpoch) {
      return { ok: false, code: 'STALE_LEASE', message: 'no active lease for this run' };
    }
    return { ok: true, run: row };
  }

  /**
   * Identity guard (docs/04 §1): a run is driven and read by the agent that claimed it. Returns an
   * error to hand back, or null when the caller is entitled to the run.
   *
   * `agentId` is the *authenticated* principal, which is always present for a `kbn_` token; it is
   * null only under `DEV_AUTH` when the caller sent no `X-Agent-Id`, where there is no identity to
   * compare and the lease alone authorizes (dev headers are not a credential in a deploy).
   */
  private denyForeignRun(run: Row, agentId: string | null | undefined): { ok: false; code: 'NOT_RUN_OWNER'; message: string } | null {
    if (agentId === null || agentId === undefined) return null;
    if ((run.agent_id as string) === agentId) return null;
    return { ok: false, code: 'NOT_RUN_OWNER', message: 'this run belongs to another agent' };
  }

  /**
   * Set the single alarm to whichever comes first: a run's reclaim deadline, or
   * the next push-delivery attempt.
   *
   * One alarm, two jobs, because a Durable Object has exactly one — and the
   * earlier deadline has to win or the later job silently cancels it. Reclaim
   * used to own it alone and `deleteAlarm()` on an idle board would have thrown
   * away a queued delivery's only chance to leave.
   *
   * Backoff doubles from the LEAST-tried pending row, so one delivery that has
   * failed four times cannot hold back one queued a second ago.
   */
  private async scheduleReclaim(): Promise<void> {
    const min = this.sql.exec(`SELECT MIN(last_heartbeat_ms) AS m FROM runs WHERE status = 'working'`).one().m;
    const reclaimAt = min === null || min === undefined ? null : Number(min) + HEARTBEAT_TIMEOUT_MS;

    const queued = this.sql
      .exec(
        `SELECT MIN(attempts) AS a, COUNT(*) AS n FROM push_deliveries
         WHERE status IN ('pending', 'failed') AND attempts < ?`,
        MAX_PUSH_ATTEMPTS,
      )
      .one();
    const drainAt =
      Number(queued.n) > 0 ? this.nowMs() + PUSH_DRAIN_BASE_MS * 2 ** Number(queued.a ?? 0) : null;

    const next = [reclaimAt, drainAt].filter((t): t is number => t !== null).sort((a, b) => a - b)[0];
    if (next === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(next);
  }

  /**
   * The body a gate travels in, built once from the gate's own row.
   *
   * It carries what a projection needs to render a question without a second
   * round trip: the card's title, the stage, who produced the work, and the
   * options. `producedBy` is included because it is the subject of the
   * separation-of-duties check at resolution.
   *
   * Read from the row rather than from `DEFAULT_GATE_OPTIONS` so that a gate
   * keeps the options it opened with. They are the same today; a gate whose
   * wording changed under it after the fact would be a question answered
   * against a different set than the one it was asked with.
   *
   * `null` when the card is gone — a gate whose card was deleted has nothing
   * to ask about.
   */
  private gatePendingBody(gate: Row): GatePendingBody | null {
    const cardId = gate.card_id as string;
    const card = this.getCard(cardId);
    if (!card) return null;
    return {
      event: 'gate.pending',
      boardId: this.getMeta('boardId'),
      cardId,
      gateId: gate.id as string,
      stageKey: gate.stage_key as string,
      returnStageKey: gate.return_stage_key as string,
      cardTitle: card.title,
      producedBy: gate.produced_by as string,
      // What the reviewer is being asked to approve.
      //
      // Without it a gate asks someone to approve work they cannot see, and
      // the only way to read it is to leave for the board. That was the state
      // for a day (supermessage#37) because every test asserted the gate's
      // SHAPE rather than whether a human could act on one.
      handoffSummary: handoffSummary(this.getCardHandoffJson(cardId)),
      // `id`/`label`, not `name`/`title`: the wire names are pinned by
      // agentpod fixtures/ecosystem-identity/matrix_gate_events.json, which
      // three repos validate against. The board's own vocabulary stops here.
      options: (JSON.parse(gate.options_json as string) as GateOption[]).map((o) => ({
        id: o.name,
        label: o.title,
      })),
      ts: gate.created_at as string,
    };
  }

  /** The gate row, or null. */
  private getGateRow(gateId: string): Row | null {
    return (this.sql.exec(`SELECT * FROM gates WHERE id = ?`, gateId).toArray()[0] as Row) ?? null;
  }

  /**
   * Every gate still waiting on a human, in the body a push carries.
   *
   * The floor beneath push. kaambaan retries a delivery five times and then
   * dead-letters it, at which point the gate is silent: the card is blocked on
   * an approval nobody was told about, and neither side is looking. This is
   * what lets the hub ask independently rather than wait to be told.
   *
   * Deliberately not the board snapshot, which carries the same gates and is a
   * human route. See `test/gate-sweep.test.ts` for why that distinction is the
   * reason this method exists.
   */
  async pendingGateDeliveries(): Promise<GatePendingBody[]> {
    return this.sql
      .exec(`SELECT * FROM gates WHERE status = 'pending' ORDER BY created_at ASC`)
      .toArray()
      .map((r) => this.gatePendingBody(r as Row))
      .filter((b): b is GatePendingBody => b !== null);
  }

  /**
   * Queue `gate.pending` deliveries for a gate that just opened (docs/05 §4).
   *
   * **Fan-out is by subscription only** — deliberately unlike
   * `notifyWorkAvailable`, and this is the one thing about this method worth
   * reading twice. `work.available` is addressed to whoever could *claim* the
   * stage, so it matches on capability. A gate is addressed to the card's
   * **owner**, a human. Copying the capability match would send approval
   * requests to whichever agents happen to advertise the review stage's
   * capability — and, because a review stage is human-owned, to nobody at all.
   */
  private notifyGatePending(gateId: string): void {
    const gate = this.getGateRow(gateId);
    if (!gate) return;
    const payload = this.gatePendingBody(gate);
    if (!payload) return;
    const body = JSON.stringify(payload);
    const ts = this.now();
    for (const cfg of this.sql.exec(`SELECT * FROM push_configs`).toArray()) {
      const events = JSON.parse(cfg.events_json as string) as string[];
      if (!events.includes('gate.pending')) continue;
      this.sql.exec(
        `INSERT INTO push_deliveries (config_id, url, body, status, attempts, created_at) VALUES (?, ?, ?, 'pending', 0, ?)`,
        cfg.id,
        cfg.url,
        body,
        ts,
      );
    }
  }

  /** Record an in-app notification for the card's owner and broadcast it (docs/07 §7). */
  private notify(kind: string, cardId: string, body: string): void {
    const card = this.getCardRow(cardId);
    const userId = card ? (card.owner_user_id as string) : null;
    this.sql.exec(
      `INSERT INTO notifications (kind, card_id, user_id, body, read, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
      kind,
      cardId,
      userId,
      body,
      this.now(),
    );
    this.emit('notification', { kind, cardId, userId });
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    const ts = this.now();
    this.sql.exec(`INSERT INTO events (type, payload_json, ts) VALUES (?, ?, ?)`, type, JSON.stringify(payload), ts);
    const seq = Number(this.sql.exec(`SELECT last_insert_rowid() AS seq`).one().seq);
    const msg = JSON.stringify({ kind: 'event', event: { seq, type, payload, ts } });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // drop broken sockets silently
      }
    }
  }

  private getMeta(k: string): string | null {
    const row = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
    return row ? (row.v as string) : null;
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
  }

  private stages(): StageDef[] {
    const raw = this.getMeta('stages');
    return raw ? (JSON.parse(raw) as StageDef[]) : [];
  }

  private countInStage(stageKey: string): number {
    return Number(this.sql.exec(`SELECT COUNT(*) AS n FROM cards WHERE current_stage_key = ?`, stageKey).one().n);
  }

  private getCardRow(id: string): Row | null {
    return this.sql.exec(`SELECT * FROM cards WHERE id = ?`, id).toArray()[0] ?? null;
  }

  private getCard(id: string): CardView | null {
    const row = this.getCardRow(id);
    return row ? this.rowToCard(row) : null;
  }

  private mustGetCard(id: string): CardView {
    const card = this.getCard(id);
    if (!card) throw new Error(`invariant violation: card ${id} missing immediately after write`);
    return card;
  }

  private allCards(): CardView[] {
    // Precompute per-card cost + attempt count in two grouped queries instead of N point queries —
    // allCards() feeds every snapshot, which is the live-feed hot path.
    const costByCard = new Map<string, number>();
    for (const r of this.sql.exec(`SELECT card_id, COALESCE(SUM(cost_usd), 0) AS c FROM usage_records GROUP BY card_id`).toArray()) {
      costByCard.set(r.card_id as string, Number(r.c));
    }
    const attemptsByCard = new Map<string, number>();
    for (const r of this.sql.exec(`SELECT card_id, COUNT(*) AS n FROM runs GROUP BY card_id`).toArray()) {
      attemptsByCard.set(r.card_id as string, Number(r.n));
    }
    return this.sql
      .exec(`SELECT * FROM cards ORDER BY priority DESC, created_at ASC`)
      .toArray()
      .map((r) => this.rowToCard(r, { costUsd: costByCard.get(r.id as string) ?? 0, attemptCount: attemptsByCard.get(r.id as string) ?? 0 }));
  }

  private rowToCard(row: Row, pre?: { costUsd: number; attemptCount: number }): CardView {
    const id = row.id as string;
    const costUsd = pre?.costUsd ?? this.cardCost(id);
    const cardCap = this.budgetCap('budgetCardUsdCap');
    const attemptCount = pre?.attemptCount ?? Number(this.sql.exec(`SELECT COUNT(*) AS n FROM runs WHERE card_id = ?`, id).one().n);
    return {
      id,
      title: row.title as string,
      spec: JSON.parse(row.spec_json as string),
      ownerUserId: row.owner_user_id as string,
      queuedBy: (row.queued_by as string | null) ?? null,
      queuedGrant: row.queued_grant ? (JSON.parse(row.queued_grant as string) as string[]) : null,
      currentStageKey: row.current_stage_key as string,
      state: row.state as TaskState,
      delegateAgentId: (row.delegate_agent_id as string | null) ?? null,
      priority: Number(row.priority),
      contextId: row.context_id as string,
      createdAt: row.created_at as string,
      updatedAt: (row.updated_at as string | null) ?? null,
      costUsd,
      // `>=` matches the enforcement gate (postActivity rejects once at/over the cap), so the red
      // chip appears exactly when billing stops.
      overBudget: cardCap !== null && costUsd >= cardCap,
      attemptCount,
    };
  }

  private rowToReference(row: Row): ReferenceView {
    return {
      id: row.id as string,
      cardId: row.card_id as string,
      url: row.url as string,
      title: (row.title as string | null) ?? null,
      subtitle: (row.subtitle as string | null) ?? null,
      provider: row.provider as string,
      sourceType: row.source_type as string,
      externalId: (row.external_id as string | null) ?? null,
      metadata: row.metadata_json ? (JSON.parse(row.metadata_json as string) as JsonValue) : null,
      syncState: row.sync_state as 'synced' | 'stale' | 'error',
      lastSyncedAt: (row.last_synced_at as string | null) ?? null,
      addedBy: row.added_by as 'agent' | 'user',
      createdAt: row.created_at as string,
      updatedAt: (row.updated_at as string | null) ?? null,
    };
  }

  private mustGetReference(id: string): ReferenceView {
    const row = this.sql.exec(`SELECT * FROM card_references WHERE id = ?`, id).toArray()[0];
    if (!row) throw new Error(`invariant violation: reference ${id} missing immediately after write`);
    return this.rowToReference(row);
  }

  private allReferences(): ReferenceView[] {
    return this.sql
      .exec(`SELECT * FROM card_references ORDER BY created_at ASC`)
      .toArray()
      .map((r) => this.rowToReference(r));
  }

  // ----- metering (docs/07 §6) -----

  private cardCost(cardId: string): number {
    return Number(this.sql.exec(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage_records WHERE card_id = ?`, cardId).one().c);
  }

  private boardCost(): number {
    return Number(this.sql.exec(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage_records`).one().c);
  }

  private budgetCap(key: 'budgetBoardUsdCap' | 'budgetCardUsdCap'): number | null {
    const v = this.getMeta(key);
    return v === null ? null : Number(v);
  }

  private boardOverBudget(): boolean {
    const cap = this.budgetCap('budgetBoardUsdCap');
    return cap !== null && this.boardCost() >= cap;
  }

  private computeUsage(sinceIso?: string): UsageSummary {
    // Optional rolling-window filter (docs/07 §6), parameterized. ts is an ISO string, so >= is chronological.
    const w = sinceIso ? ` WHERE ts >= ?` : '';
    const p = sinceIso ? [sinceIso] : [];
    const totals = this.sql
      .exec(
        `SELECT COALESCE(SUM(cost_usd), 0) AS cost,
                COALESCE(SUM(CASE WHEN estimated = 1 THEN cost_usd ELSE 0 END), 0) AS est,
                COALESCE(SUM(input_tokens), 0) AS itok,
                COALESCE(SUM(output_tokens), 0) AS otok
         FROM usage_records${w}`,
        ...p,
      )
      .one();
    const unpriced = this.sql
      .exec(`SELECT COUNT(*) AS n FROM usage_records WHERE estimated = 1 AND cost_usd = 0${sinceIso ? ' AND ts >= ?' : ''}`, ...p)
      .one();
    const byModel = this.sql
      .exec(
        `SELECT COALESCE(model, '(unknown)') AS model, SUM(cost_usd) AS cost, SUM(input_tokens) AS itok, SUM(output_tokens) AS otok
         FROM usage_records${w} GROUP BY model ORDER BY cost DESC`,
        ...p,
      )
      .toArray()
      .map((r) => ({ model: r.model as string, costUsd: Number(r.cost), inputTokens: Number(r.itok), outputTokens: Number(r.otok) }));
    const byAgent = this.sql
      .exec(`SELECT agent_id, SUM(cost_usd) AS cost FROM usage_records${w} GROUP BY agent_id ORDER BY cost DESC`, ...p)
      .toArray()
      .map((r) => ({ agentId: r.agent_id as string, costUsd: Number(r.cost) }));
    const byCard = this.sql
      .exec(`SELECT card_id, SUM(cost_usd) AS cost FROM usage_records${w} GROUP BY card_id ORDER BY cost DESC`, ...p)
      .toArray()
      .map((r) => ({ cardId: r.card_id as string, costUsd: Number(r.cost) }));
    return {
      totalCostUsd: Number(totals.cost),
      estimatedCostUsd: Number(totals.est),
      totalInputTokens: Number(totals.itok),
      totalOutputTokens: Number(totals.otok),
      unpricedRecords: Number(unpriced.n),
      byModel,
      byAgent,
      byCard,
    };
  }

  private snapshot(): BoardSnapshot {
    const boardId = this.getMeta('boardId');
    return {
      boardId,
      tenantId: this.getMeta('tenantId'),
      name: this.getMeta('name'),
      stages: this.stages(),
      cards: boardId ? this.allCards() : [],
      gates: boardId ? this.pendingGates() : [],
      elicitations: boardId ? this.pendingElicitations() : [],
      references: boardId ? this.allReferences() : [],
      usage: boardId ? this.boardUsage() : { totalCostUsd: 0, estimatedCostUsd: 0, budgetUsd: null, cardUsdCap: null, overBudget: false },
      github: {
        issueTrigger: this.getMeta('githubIssueTrigger') === '1',
        webhookConfigured: this.getMeta('githubWebhookSecret') !== null,
        triggerGrantCount: this.triggerGrant()?.length ?? null,
      },
    };
  }

  private boardUsage(): BoardUsage {
    const u = this.computeUsage();
    const boardCap = this.budgetCap('budgetBoardUsdCap');
    return {
      totalCostUsd: u.totalCostUsd,
      estimatedCostUsd: u.estimatedCostUsd,
      budgetUsd: boardCap,
      cardUsdCap: this.budgetCap('budgetCardUsdCap'),
      overBudget: boardCap !== null && u.totalCostUsd >= boardCap, // consistent with the claim/billing gate
    };
  }

  private now(): string {
    return new Date().toISOString();
  }

  private nowMs(): number {
    return Date.now();
  }
}
