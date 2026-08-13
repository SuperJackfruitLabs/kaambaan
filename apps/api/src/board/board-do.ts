import { DurableObject } from 'cloudflare:workers';
import type { TaskState } from '@kaambaan/contract';
import type { Env } from '../env';
import { newId } from '../ids';
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

/** A choice presented to a human at an approval gate (HumanLayer-style options, docs/08 §6). */
export interface GateOption {
  name: string;
  title: string;
  promptFill?: string;
  interactive?: boolean;
}

export type GateDecision = 'approve' | 'request_changes' | 'reject';

export interface GateView {
  id: string;
  cardId: string;
  stageKey: string;
  status: 'pending' | 'resolved';
  decision: string | null;
  options: GateOption[];
  producedBy: string;
  createdAt: string;
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
  references: ReferenceView[];
  usage: BoardUsage;
  github: { issueTrigger: boolean; webhookConfigured: boolean };
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
  | 'SEPARATION_OF_DUTIES'
  | 'INVALID_URL'
  | 'INVALID_SIGNATURE'
  | 'NOT_CONFIGURED'
  | 'INVALID_DELIVERY'
  | 'INVALID_USAGE'
  | 'BUDGET_EXCEEDED';

export type Result<T> = { ok: true; value: T } | { ok: false; code: BoardErrorCode; message: string };

/** The Board DO's RPC surface as the Worker calls it — hand-typed to avoid deep RPC type instantiation. */
export interface BoardStub {
  init(board: BoardInit): Promise<BoardSnapshot>;
  createCard(input: {
    title: string;
    ownerUserId: string;
    spec?: JsonValue;
    priority?: number;
  }): Promise<Result<CardView>>;
  moveCard(cardId: string, toStageKey: string, actorUserId?: string): Promise<Result<CardView>>;
  updateCard(cardId: string, patch: { title?: string; spec?: JsonValue; priority?: number }): Promise<Result<CardView>>;
  deleteCard(cardId: string): Promise<Result<{ ok: true }>>;
  setName(name: string): Promise<Result<{ ok: true }>>;
  getState(): Promise<BoardSnapshot>;
  getEvents(limit?: number): Promise<BoardEvent[]>;
  // Agent contract (docs/04 §3)
  claim(input: { agentId: string; capabilities: string[]; maxConcurrency?: number; profileKey?: string }): Promise<ClaimResult>;
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
  getCardActivities(cardId: string): Promise<{ activities: ActivityView[]; handoff: JsonValue | null }>;
  estimateCardCost(cardId: string): Promise<Result<EstimateView>>;
  getNotifications(opts?: { unreadOnly?: boolean }): Promise<NotificationView[]>;
  markNotificationRead(seq: number): Promise<Result<{ ok: true }>>;
  registerPushConfig(input: PushConfigInput): Promise<Result<{ configId: string }>>;
  getPushDeliveries(opts?: { status?: string }): Promise<PushDeliveryView[]>;
  dispatchPushDeliveries(): Promise<{ sent: number; failed: number }>;
  setGithubSecret(secret: string): Promise<Result<{ configured: true }>>;
  setGithubConfig(input: { secret?: string; issueTrigger?: boolean }): Promise<Result<{ ok: true }>>;
  createCardFromTrigger(input: {
    title: string;
    ownerUserId: string;
    spec?: JsonValue;
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
        (id, title, spec_json, owner_user_id, current_stage_key, state, priority, context_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?)`,
      id,
      input.title,
      JSON.stringify(input.spec ?? {}),
      input.ownerUserId,
      first.key,
      input.priority ?? 0,
      contextId,
      now,
      now,
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
    source?: { url: string; provider?: string; sourceType?: string; externalId?: string; title?: string; metadata?: JsonValue };
  }): Promise<Result<{ card: CardView; reference: ReferenceView | null; referenceError?: string }>> {
    const created = await this.createCard({ title: input.title, ownerUserId: input.ownerUserId, spec: input.spec });
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
  async moveCard(cardId: string, toStageKey: string, actorUserId?: string): Promise<Result<CardView>> {
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
    this.sql.exec(
      `UPDATE cards SET current_stage_key = ?, state = 'submitted', delegate_agent_id = NULL, current_run_id = NULL, failure_count = 0, updated_at = ? WHERE id = ?`,
      target.key,
      now,
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

  /** Edit a card's title / spec / priority (human, docs/07 §4). */
  async updateCard(cardId: string, patch: { title?: string; spec?: JsonValue; priority?: number }): Promise<Result<CardView>> {
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
    for (const t of ['usage_records', 'activities', 'runs', 'gates', 'card_references', 'notifications']) {
      this.sql.exec(`DELETE FROM ${t} WHERE card_id = ?`, cardId);
    }
    this.sql.exec(`DELETE FROM cards WHERE id = ?`, cardId);
    this.emit('card.deleted', { cardId });
    return { ok: true, value: { ok: true } };
  }

  /** Rename the board (the catalog row is renamed alongside, by the Worker). */
  async setName(name: string): Promise<Result<{ ok: true }>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    this.setMeta('name', name);
    this.emit('board.renamed', { name });
    return { ok: true, value: { ok: true } };
  }

  async getState(): Promise<BoardSnapshot> {
    return this.snapshot();
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
  async setGithubConfig(input: { secret?: string; issueTrigger?: boolean }): Promise<Result<{ ok: true }>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    if (input.secret !== undefined) this.setMeta('githubWebhookSecret', input.secret);
    if (input.issueTrigger !== undefined) this.setMeta('githubIssueTrigger', input.issueTrigger ? '1' : '0');
    return { ok: true, value: { ok: true } };
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

  /** In-app notifications for this board, newest first (docs/07 §7). */
  async getNotifications(opts?: { unreadOnly?: boolean }): Promise<NotificationView[]> {
    const where = opts?.unreadOnly ? `WHERE read = 0` : '';
    return this.sql
      .exec(`SELECT * FROM notifications ${where} ORDER BY seq DESC LIMIT 200`)
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
  async getCardActivities(cardId: string): Promise<{ activities: ActivityView[]; handoff: JsonValue | null }> {
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
    return { activities, handoff: this.parseHandoff(this.getCardHandoffJson(cardId)) };
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

  /** Atomically hand a ready, capability-matched card to an agent, within its concurrency limit. */
  async claim(input: {
    agentId: string;
    capabilities: string[];
    maxConcurrency?: number;
    profileKey?: string;
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

    const card = this.rowToCard(row);
    const leaseEpoch = Number(row.claim_seq) + 1;
    const runId = newId('run');
    const now = this.now();
    const nowMs = this.nowMs();
    this.sql.exec(
      `INSERT INTO runs (id, card_id, stage_key, agent_id, lease_epoch, status, outcome, last_heartbeat_ms, started_at, ended_at, profile_key)
       VALUES (?, ?, ?, ?, ?, 'working', NULL, ?, ?, NULL, ?)`,
      runId,
      card.id,
      card.currentStageKey,
      input.agentId,
      leaseEpoch,
      nowMs,
      now,
      input.profileKey ?? null,
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

  /** Escalate to a human — the card parks in input-required (docs/08 §6 — gates resolve in P3). */
  async block(input: RunVerbInput & { reason: string }): Promise<Result<CardView>> {
    const auth = this.authorizeRun(input);
    if (!auth.ok) return auth;
    const run = auth.run;
    const cardId = run.card_id as string;
    const now = this.now();
    this.sql.exec(`UPDATE runs SET status = 'ended', outcome = 'blocked', ended_at = ? WHERE id = ?`, now, input.runId);
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
    return id;
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

  private async scheduleReclaim(): Promise<void> {
    const min = this.sql.exec(`SELECT MIN(last_heartbeat_ms) AS m FROM runs WHERE status = 'working'`).one().m;
    if (min === null || min === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Number(min) + HEARTBEAT_TIMEOUT_MS);
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
      references: boardId ? this.allReferences() : [],
      usage: boardId ? this.boardUsage() : { totalCostUsd: 0, estimatedCostUsd: 0, budgetUsd: null, cardUsdCap: null, overBudget: false },
      github: { issueTrigger: this.getMeta('githubIssueTrigger') === '1', webhookConfigured: this.getMeta('githubWebhookSecret') !== null },
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
