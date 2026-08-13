import { z } from 'zod';
import {
  TenantId,
  UserId,
  MembershipId,
  BoardId,
  AgentId,
  CardId,
  TaskId,
  RunId,
  ReferenceId,
  ContextId,
} from './ids';
import {
  Role,
  TaskState,
  StageGate,
  StageOwnerKind,
  RunOutcome,
  AgentStatus,
  ConnectionType,
  ReferenceProvider,
  ReferenceSourceType,
  SyncState,
} from './primitives';

const timestamps = {
  createdAt: z.string(),
  updatedAt: z.string().optional(),
};

/**
 * kaambaan's LOCAL isolation boundary (docs/02) — hard, and not an authority.
 *
 * Principal, Team, Role and authority belong to the Organization plane, which does not exist
 * yet; kaambaan does not model them. What it does own is a note that the same real organisation
 * is also known somewhere else: `externalSource` names the system ('agentpod' today, 'org-plane'
 * later) and `externalId` is that system's id, left opaque because it is not kaambaan's id space.
 *
 * The pair is all-or-nothing. An id without the system it came from cannot be joined against
 * anything, and a wrong join is harder to notice than a missing one. Enforced here and, more
 * importantly, in the database (`tenants_external_pair`, migration 0002) — matching the same
 * pair and the same CHECK on AgentPod's rows.
 *
 * Absent is the normal, complete state: a standalone kaambaan never sets either.
 */
export const Tenant = z
  .object({
    id: TenantId,
    slug: z.string().min(1),
    name: z.string().min(1),
    externalId: z.string().min(1).nullish(),
    externalSource: z.string().min(1).nullish(),
    ...timestamps,
  })
  .refine((t) => (t.externalId == null) === (t.externalSource == null), {
    message: 'externalId and externalSource must be set together, or not at all',
    path: ['externalSource'],
  });
export type Tenant = z.infer<typeof Tenant>;

export const User = z.object({
  id: UserId,
  email: z.string(),
  name: z.string().optional(),
  ...timestamps,
});
export type User = z.infer<typeof User>;

export const Membership = z.object({
  id: MembershipId,
  tenantId: TenantId,
  userId: UserId,
  role: Role,
  ...timestamps,
});
export type Membership = z.infer<typeof Membership>;

/** A pipeline stage (board column). */
export const Stage = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  order: z.number().int().min(0),
  ownerKind: StageOwnerKind,
  owner: z.string().optional(), // capability tag or agentId; absent for human-only stages
  gate: StageGate.default('none'),
  wipLimit: z.number().int().min(1).optional(),
});
export type Stage = z.infer<typeof Stage>;

export const Board = z.object({
  id: BoardId,
  tenantId: TenantId,
  name: z.string().min(1),
  stages: z.array(Stage).min(1),
  ...timestamps,
});
export type Board = z.infer<typeof Board>;

/** A registered external worker (app-actor, never a human user). */
export const Agent = z.object({
  id: AgentId,
  tenantId: TenantId,
  name: z.string().min(1),
  iconUrl: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  connection: z.array(ConnectionType).default(['rest']),
  concurrency: z.number().int().min(1).default(1),
  status: AgentStatus.default('offline'),
  ...timestamps,
});
export type Agent = z.infer<typeof Agent>;

/** First-class external link (docs/06). Idempotent on (cardId, url). */
export const Reference = z.object({
  id: ReferenceId,
  cardId: CardId,
  tenantId: TenantId,
  url: z.string().min(1),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  provider: ReferenceProvider,
  sourceType: ReferenceSourceType,
  externalId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  syncState: SyncState.default('synced'),
  lastSyncedAt: z.string().optional(),
  addedBy: z.enum(['agent', 'user']),
  ...timestamps,
});
export type Reference = z.infer<typeof Reference>;

/** The durable unit of work. The human `ownerUserId` is always the accountable party. */
export const Card = z.object({
  id: CardId,
  boardId: BoardId,
  tenantId: TenantId,
  contextId: ContextId,
  title: z.string().min(1),
  spec: z.record(z.string(), z.unknown()).default({}),
  ownerUserId: UserId,
  currentStageKey: z.string().min(1),
  delegateAgentId: AgentId.optional(),
  currentTaskId: TaskId.optional(),
  priority: z.number().int().default(0),
  labels: z.array(z.string()).default([]),
  archivedAt: z.string().optional(),
  ...timestamps,
});
export type Card = z.infer<typeof Card>;

/** An A2A-style unit of agent work on a card at a stage. Immutable once terminal. */
export const Task = z.object({
  id: TaskId,
  cardId: CardId,
  tenantId: TenantId,
  contextId: ContextId,
  stageKey: z.string().min(1),
  state: TaskState,
  metadata: z.record(z.string(), z.unknown()).optional(), // structured handoff to the next stage
  ...timestamps,
});
export type Task = z.infer<typeof Task>;

/** One execution attempt of a Task by one agent (Linear Session × Hermes task_run). */
export const Run = z.object({
  id: RunId,
  taskId: TaskId,
  tenantId: TenantId,
  agentId: AgentId,
  leaseEpoch: z.number().int().min(0),
  outcome: RunOutcome.optional(),
  lastHeartbeatAt: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
});
export type Run = z.infer<typeof Run>;
