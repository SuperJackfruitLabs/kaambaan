import { z } from 'zod';

/**
 * Canonical task states — mirrors the A2A `TaskState` machine (see docs/03-card-lifecycle.md).
 * `canceled` is spelled with a single "l" to match A2A exactly.
 */
export const TaskState = z.enum([
  'submitted',
  'working',
  'input-required',
  'auth-required',
  'completed',
  'rejected',
  'failed',
  'canceled',
]);
export type TaskState = z.infer<typeof TaskState>;

export const TERMINAL_STATES = ['completed', 'rejected', 'failed', 'canceled'] as const;
export const INTERRUPTED_STATES = ['input-required', 'auth-required'] as const;
export const ACTIVE_STATES = ['submitted', 'working'] as const;

export function isTerminal(state: TaskState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}
export function isInterrupted(state: TaskState): boolean {
  return (INTERRUPTED_STATES as readonly string[]).includes(state);
}

/** Typed agent activities (see docs/04-agent-contract.md §4). `prompt` is human-authored. */
export const ActivityType = z.enum([
  'thought',
  'action',
  'response',
  'elicitation',
  'error',
  'prompt',
]);
export type ActivityType = z.infer<typeof ActivityType>;

/** Render/observability hint aligned with OpenInference/OTel span kinds (docs/07 §2). */
export const ActivityKind = z.enum([
  'AGENT',
  'LLM',
  'TOOL',
  'THINKING',
  'MESSAGE',
  'CHAIN',
  'RETRIEVER',
  'GUARDRAIL',
  'STAGE_TRANSITION',
  'PIPELINE',
]);
export type ActivityKind = z.infer<typeof ActivityKind>;

/** Typed overlay on an activity (docs/04 §4). Open enum, extended for gates. */
export const Signal = z.enum(['stop', 'auth', 'select', 'approve', 'reject']);
export type SignalType = z.infer<typeof Signal>;

export const Role = z.enum(['owner', 'admin', 'member', 'viewer']);
export type Role = z.infer<typeof Role>;

export const StageGate = z.enum(['none', 'approval']);
export type StageGate = z.infer<typeof StageGate>;

export const StageOwnerKind = z.enum(['capability', 'agent', 'human']);
export type StageOwnerKind = z.infer<typeof StageOwnerKind>;

export const RunOutcome = z.enum([
  'completed',
  'blocked',
  'rejected',
  'crashed',
  'timed_out',
  'reclaimed',
  'canceled',
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

// `AgentStatus` and `ConnectionType` were removed on 2026-09-02 along with the columns they
// described (migration 0005). Neither was ever written: every agent read 'offline' from the day
// it was created, including while it held a live lease, and REST is the only transport an agent
// has ever had. Liveness is knowable from `runs` in the board DO, which is where a claim happens.


/**
 * The one spelling of a work-capability tag.
 *
 * A capability is how kaambaan routes a card to an agent, and the whole of the match is
 * `agent.capabilities.includes(stage.owner)` — exact string equality between two free strings.
 * Nothing defines the set, so every place that produces one had invented its own spelling: board
 * templates slugified a stage name (`code-review`), the agent editor lowercased it
 * (`code review`), and the create route normalised nothing at all. Three spellings of one word,
 * compared by equality, matching nothing.
 *
 * This is a normaliser, NOT the capability registry the charter's Capabilities layer calls for
 * (`strategy/2026-08-12-layer-reference.md`, P1/P3, nouns `Capability, Provider`). That registry
 * would say which capabilities EXIST and what they mean; this only guarantees that two people
 * typing the same words produce the same tag. It belongs in the contract because it is the one
 * thing both the Worker and the board UI must agree on, and a normaliser each side implements
 * separately is the bug it exists to prevent.
 *
 * Work capabilities are also NOT AgentPod's station capabilities — `acp`, `fs.read`, `terminal`
 * are protocol capabilities, and matching a grant on either was rejected as "the same word, two
 * vocabularies" (charter decisions/2026-08-15-a-grant-names-an-agent-per-plane.md).
 */
export function capabilityTag(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Normalise a whole set, dropping empties and duplicates, order preserved. */
export function capabilityTags(raw: string[]): string[] {
  return [...new Set(raw.map(capabilityTag).filter((c) => c !== ''))];
}

export const ReferenceProvider = z.enum(['github', 'gitlab', 'docs', 'url']);
export type ReferenceProvider = z.infer<typeof ReferenceProvider>;

export const ReferenceSourceType = z.enum([
  'issue',
  'pull_request',
  'repo',
  'branch',
  'commit',
  'doc',
  'url',
]);
export type ReferenceSourceType = z.infer<typeof ReferenceSourceType>;

export const SyncState = z.enum(['synced', 'stale', 'error']);
export type SyncState = z.infer<typeof SyncState>;

/**
 * What a human may decide at an approval gate.
 *
 * Defined here rather than beside the state machine that consumes it because
 * it is a **cross-repo contract value**, not an internal one. AgentPod's
 * Application Service projects these into a Matrix room as an option list and
 * sends one back to resolve the gate; supermessage draws a button per value.
 * Pinned by `fixtures/ecosystem-identity/matrix_gate_events.json` in AgentPod,
 * which all three repos validate against.
 *
 * The consequence of that, and the reason this comment is here: adding a value
 * is not a local change. A gate offering an option no client knows renders a
 * button that resolves nothing — see `charter` →
 * `decisions/2026-08-30-a-gate-closes-over-chat.md`, which records free-form
 * option ids as the one correction to kaambaan#34 that would have failed at
 * runtime rather than in review.
 */
export const GateDecision = z.enum(['approve', 'request_changes', 'reject']);
export type GateDecision = z.infer<typeof GateDecision>;
