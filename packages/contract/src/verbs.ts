import { z } from 'zod';
import { BoardId, CardId, RunId, TaskId, AgentId, ElicitationId } from './ids';
import { ActivityType, Signal, ReferenceProvider, ReferenceSourceType } from './primitives';
import { Card, Task, Reference } from './entities';

/**
 * Surface-neutral verb input/output schemas (docs/04 §3). The same schema validates a call
 * whether it arrives over MCP or REST — there is exactly one contract.
 */

export const ClaimInput = z.object({
  boardId: BoardId,
  capabilities: z.array(z.string()).default([]),
  leaseEpoch: z.number().int().min(0).optional(),
});
export type ClaimInput = z.infer<typeof ClaimInput>;

/** A claim either yields work or reports none available. */
export const ClaimResult = z.union([
  z.object({
    claimed: z.literal(true),
    runId: RunId,
    task: Task,
    card: Card,
    handoff: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ claimed: z.literal(false) }),
]);
export type ClaimResult = z.infer<typeof ClaimResult>;

export const HeartbeatInput = z.object({
  runId: RunId,
  leaseEpoch: z.number().int().min(0),
  progress: z.record(z.string(), z.unknown()).optional(),
});
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;

/**
 * Post one typed activity. A signal's structured payload — an `elicitation`'s `options`, an `auth`
 * signal's `url` — travels in `parameter`, the one field the board persists and hands back.
 */
export const PostActivityInput = z.object({
  runId: RunId,
  leaseEpoch: z.number().int().min(0),
  type: ActivityType,
  ephemeral: z.boolean().default(false),
  body: z.string().optional(),
  action: z.string().optional(),
  parameter: z.unknown().optional(),
  result: z.unknown().optional(),
  signal: Signal.optional(),
  idempotencyKey: z.string().optional(),
});
export type PostActivityInput = z.infer<typeof PostActivityInput>;

/**
 * Answer an agent's `elicitation` — the human half of the return path. Answering transitions the
 * card `input-required → working` (or `auth-required → working`) so the agent that asked, which is
 * still holding its lease, can collect the answer from the run it owns and carry on.
 */
export const AnswerElicitationInput = z.object({
  elicitationId: ElicitationId,
  /** The `name` of one of the options the agent offered; required when it offered any. */
  option: z.string().optional(),
  /** Free text — the whole answer when no options were offered, or a note alongside one. */
  text: z.string().optional(),
});
export type AnswerElicitationInput = z.infer<typeof AnswerElicitationInput>;

export const AddReferenceInput = z.object({
  cardId: CardId,
  url: z.string().min(1),
  title: z.string().optional(),
  provider: ReferenceProvider,
  sourceType: ReferenceSourceType,
  externalId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AddReferenceInput = z.infer<typeof AddReferenceInput>;

export const SubmitForReviewInput = z.object({
  runId: RunId,
  leaseEpoch: z.number().int().min(0),
  output: z.record(z.string(), z.unknown()).optional(),
});
export type SubmitForReviewInput = z.infer<typeof SubmitForReviewInput>;

export const CompleteInput = z.object({
  runId: RunId,
  leaseEpoch: z.number().int().min(0),
  handoff: z
    .object({
      summary: z.string(),
      outputs: z.array(z.string()).optional(),
      verification: z.array(z.string()).optional(),
      residualRisk: z.array(z.string()).optional(),
      next: z.string().optional(),
    })
    .optional(),
});
export type CompleteInput = z.infer<typeof CompleteInput>;

export const BlockInput = z.object({
  runId: RunId,
  leaseEpoch: z.number().int().min(0),
  reason: z.string().min(1),
});
export type BlockInput = z.infer<typeof BlockInput>;

export const ReleaseInput = z.object({
  runId: RunId,
  leaseEpoch: z.number().int().min(0),
  reason: z.string().optional(),
});
export type ReleaseInput = z.infer<typeof ReleaseInput>;

/** Reference returned to callers after an idempotent upsert. */
export const AddReferenceResult = z.object({ reference: Reference });
export type AddReferenceResult = z.infer<typeof AddReferenceResult>;

/** Convenience map of agentId-scoped claim filters, used by routing. */
export const ClaimFilter = z.object({
  agentId: AgentId,
  capabilities: z.array(z.string()),
});
export type ClaimFilter = z.infer<typeof ClaimFilter>;
