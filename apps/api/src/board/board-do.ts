import { DurableObject } from 'cloudflare:workers';
import { canTransition, nextState, type GateDecision, type TaskEventType, type TaskState } from '@superpipeline/contract';
import type { Env } from '../env';
import { newId } from '../ids';
import { grantPermitsAgent, isControlPairEnforced } from '../auth/grant-match';
import { capabilityTag, normalizeRequirement, stageCapabilitiesMet } from '@superpipeline/contract';
import { parseElicitationOptions } from './elicitation';
import { evaluateCompletion, type CompletionRequirement } from '@superpipeline/contract';
import { outcomeInputError, returnStageError, routeOutcome, type StageOutcome } from '@superpipeline/contract';
import { verifyGithubSignature, verifyForgeSignature } from '../references/github-signature';
import { mapGithubEvent } from '../references/github-events';
import { mapForgeEvent } from '../references/forge-events';
import { estimateCostUsd } from '../metering/pricing';
import { parseWindowMs } from '../metering/window';
import { PUSH_TIMEOUT_MS, signAndSend, type PushSender } from '../push/deliver';
import { isPublicHttpUrl } from '../push/ssrf';
import { resolveLabelNames } from '../db/labels';
import { parseRule, nextFireAt, advanceFireTime } from './recurrence';
import { wouldCycle, type LinkKind, type LinkRow } from './links';
import { buildRunReport, mapRunStatus, type RunReport, type RunReportDraft } from '../superwitness/report';
import { reportingEnabled, reporterConfig } from '../superwitness/config';
import {
  defaultReporterFetch,
  postRunReports,
  runReportBackoffMs,
  RUN_REPORT_MAX_ATTEMPTS,
  ServiceTokenCache,
  type ReporterFetch,
} from '../superwitness/client';
import { logReporter } from '../superwitness/log';
import { agentNamesFor, principalIdsFor } from '../db/catalog';
import { SUBSCRIBABLE_EVENTS, cardIdsOf, isRecordEvent, type RecordPushBody } from '../push/events';

/** JSON-serializable value — used for everything that crosses the Durable Object RPC boundary. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Strip the pre-migration keys `spec.due` and `spec.labels` from a spec, once the once-per-board
 * backfill has already run.
 *
 * `backfillDueDates`/`backfillLabelNames` move these onto `due_at`/`labels` exactly once per
 * board (`dueBackfillDone`), and BEFORE that pass a card legitimately carries them — that is what
 * the backfill exists to find. Nothing stopped a caller — an API or MCP client posting raw `spec`
 * JSON, or `CardDrawer.saveCard`'s `...card.spec` spread carrying a stale key forward — from
 * writing `spec.due`/`spec.labels` again AFTER that pass, and the backfill's own guard
 * (`WHERE due_at IS NULL`) then skips that card forever: the same save that writes the stale spec
 * key also writes `due_at` directly, so the key is not "cleared at the next tick" — it is
 * permanent. Stripped here (once the guard says there is nothing left to migrate) rather than
 * refused with a 400: a 400 would break saving any card that still carries a stale key for an
 * unrelated reason, whereas stripping is self-healing and closes a door the backfill cannot reach.
 */
function stripStaleSpecKeys(spec: JsonValue | undefined): JsonValue | undefined {
  if (spec === undefined || spec === null || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  if (!('due' in spec) && !('labels' in spec)) return spec;
  const { due: _due, labels: _labels, ...rest } = spec;
  return rest;
}

/**
 * Turn one pasted/typed line into a title, the way `splitCard` (Task 15) does for every line it is
 * given. The input is whatever a human or an agent pasted — often a markdown checklist — so
 * `- [ ] Write the spec` must not become a card titled `- [ ] Write the spec`.
 *
 * Stripped in order: a leading `-`/`*`/`<digit>.` bullet, then a `[ ]`/`[x]` checkbox, then
 * whitespace. A line that is blank before or after stripping comes back `''`, which `splitCard`
 * filters out rather than turning into an untitled card.
 *
 * Both marker regexes require `\s+` (one-or-more), not `\s*` (zero-or-more), after the marker —
 * markdown's own rule is that a bullet/checkbox is followed by a SEPARATING space, and without
 * that requirement this silently mangled caller data that merely started with a similar character:
 * `2.0 launch plan` → `0 launch plan`, `1.5x throughput` → `5x throughput`, `-fix the bug` →
 * `fix the bug`, `**bold title**` → `*bold title**`. None of those are bullets; a version number,
 * a measurement, a hyphenated word and a bold marker all happen to start the same way a real
 * bullet does, and the caller got no signal that its title had been rewritten — that mangled name
 * is what the next agent's prompt would carry.
 *
 * Deliberately does NOT trim `raw` as one whole-string operation before stripping (only the final
 * return trims): an earlier version did, and that pre-trim consumed the separating space `\s+`
 * needs to see, so a line that was JUST a checkbox with a trailing space (`'- [ ] '`) stopped
 * stripping to `''` — the one-space requirement above only works if that space is still there when
 * the checkbox regex runs. `'- [ ] '` stripping to `''` is not a bug to guard against, it is the
 * spec: a marker with no title text is blank, the same as an empty line — see the "ignores blank
 * lines" test, which asserts exactly this input is dropped.
 *
 * Each marker regex instead carries its OWN leading `\s*`, rather than one whole-string pre-trim,
 * so an indented bullet/checkbox — the ordinary shape of a nested markdown checklist (`- [ ] parent`
 * with `  - [ ] child` under it) — still unwraps. This differs from the removed pre-trim in the one
 * way that matters: `\s*` at the FRONT of a regex only ever consumes LEADING characters at THAT
 * match's own start position; it cannot reach into the string's trailing end the way a whole-string
 * `.trim()` did, so it cannot repeat the original bug of eating the checkbox's separating space
 * before the checkbox regex gets to run. Verified empirically against every case above plus
 * indentation (leading spaces, a leading tab, a nested item) before shipping — see the fix-round
 * report.
 */
function stripListLineSyntax(raw: string): string {
  let s = raw.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''); // optional indent, then bullet: "-", "*", or "2.", each followed by a space
  s = s.replace(/^\s*\[[ xX]\]\s+/, ''); // optional indent, then checkbox: "[ ]" or "[x]"/"[X]", followed by a space
  return s.trim();
}

/** The most children one `splitCard` call may create — see its doc comment. */
const MAX_SPLIT_CHILDREN = 20;

/** How long an agent may go without a heartbeat before its run is reclaimed (docs/08 §3, ⚠️ OPEN). */
const HEARTBEAT_TIMEOUT_MS = 15 * 60 * 1000;
/** Consecutive failed/reclaimed runs before a card auto-blocks for a human (docs/08 §4, ⚠️ OPEN). */
const CIRCUIT_BREAKER_LIMIT = 2;
/**
 * How many times a judging stage's `changes-needed` may send a card back on its own before the
 * next one parks it for a person. The breaker's number, on purpose: an automatic return is the
 * board retrying on the agent's behalf, and it gets the same patience a crash does.
 */
const MAX_AUTOMATIC_RETURNS = CIRCUIT_BREAKER_LIMIT;
/** The outcomes `complete` accepts (`StageOutcome`), for a caller that did not parse. */
const OUTCOMES: ReadonlySet<string> = new Set<StageOutcome>(['pass', 'changes-needed', 'needs-person']);
/** Push delivery attempts before a delivery is dead-lettered (docs/05 §4). */
const MAX_PUSH_ATTEMPTS = 5;
/** One config's share of a single drain. */
const MAX_PUSH_PER_CONFIG_PER_DRAIN = 10;
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

/** superwitness run reports (superwitness app spec §3.5; rulings R12, R13). */
const RUN_REPORT_BATCH_MAX = 100;
const RUN_REPORT_BATCH_MAX_BYTES = 200 * 1024;
const RUN_REPORT_MAX_BATCHES_PER_DRAIN = 10;

/**
 * How much of the previous stage's handoff a gate carries into a room.
 *
 * A room is not a document store, and supermessage caps a custom event's
 * content at 8 KiB before a renderer ever sees it — so this is cut somewhere
 * regardless. Better to cut it deliberately here, where the whole value is
 * still in hand, than to have a client truncate a blob it cannot interpret.
 */
const HANDOFF_SUMMARY_MAX_CHARS = 600;

/** A canonical subject prepared before the card/gate binding transaction. */
interface PreparedApprovalSubject {
  id: string;
  schema: string;
  revision: number;
  canonicalBytes: Uint8Array;
  digest: string;
  producerRunId: string;
  producedBy: string;
  createdAt: string;
}

export interface ApprovalSubjectView {
  id: string;
  digest: string;
  schema: string;
  revision: number;
  canonical: JsonValue;
}

export interface ApprovalSubjectVerification {
  boardId: string;
  projectId: string;
  cardId: string;
  runId: string;
  stageKey: string;
  canonicalBytesBase64: string;
  expiresAt: string;
  subject: ApprovalSubjectView & { account: JsonValue };
  gate: { id: string; decision: string; decidedBy: string; resolvedAt: string };
}

/** RFC 8785/JCS serialization for JSON values (ECMAScript primitives, sorted object keys). */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('approval subject contains a non-I-JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`;
}

function storedBytes(value: SqlStorageValue): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('approval subject canonical bytes are not binary');
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

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

/** Delivery is chosen by the human; both choices approve the same immutable digest. */
const APPROVAL_SUBJECT_GATE_OPTIONS: GateOption[] = [
  { name: 'approve_manual', title: "Approve — I'll post it myself" },
  { name: 'approve_automatic', title: 'Approve — post automatically' },
  { name: 'request_changes', title: 'Request changes', interactive: true },
  { name: 'reject', title: 'Reject' },
];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Validate the complete public social-publish/v1 payload before any durable write. */
function socialPublishPayloadError(value: unknown): string | null {
  const payload = record(value);
  if (!payload) return 'publicationPayload must be an object';
  if (payload.channel !== 'x') return 'publicationPayload.channel must be "x"';

  const account = record(payload.account);
  if (!account || account.platform !== 'x' || !nonEmptyString(account.userId) || !nonEmptyString(account.username)) {
    return 'publicationPayload.account must identify an x userId and username';
  }

  if (!Array.isArray(payload.items) || payload.items.length === 0) return 'publicationPayload.items must not be empty';
  for (let position = 0; position < payload.items.length; position += 1) {
    const item = record(payload.items[position]);
    if (!item || !Number.isInteger(item.index) || item.index !== position || !nonEmptyString(item.text)) {
      return `publicationPayload.items[${position}] needs its ordered index and exact text`;
    }
    if (!Array.isArray(item.media)) return `publicationPayload.items[${position}].media must be an array`;
    for (let mediaIndex = 0; mediaIndex < item.media.length; mediaIndex += 1) {
      const media = record(item.media[mediaIndex]);
      if (
        !media ||
        !nonEmptyString(media.objectRef) ||
        typeof media.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(media.sha256) ||
        !nonEmptyString(media.mime) ||
        !Number.isInteger(media.size) ||
        (media.size as number) < 0 ||
        typeof media.altText !== 'string' ||
        !nonEmptyString(media.rightsRef)
      ) {
        return `publicationPayload.items[${position}].media[${mediaIndex}] is incomplete`;
      }
    }
    for (const key of ['replyToPostId', 'quotePostId'] as const) {
      if (item[key] !== null && !nonEmptyString(item[key])) {
        return `publicationPayload.items[${position}].${key} must be null or a post id`;
      }
    }
  }

  const timing = record(payload.timing);
  if (
    !timing ||
    (timing.mode !== 'immediate' && timing.mode !== 'scheduled') ||
    (timing.notBefore !== null && !nonEmptyString(timing.notBefore)) ||
    !nonEmptyString(timing.expiresAt) ||
    Number.isNaN(Date.parse(timing.expiresAt)) ||
    (timing.notBefore !== null && Number.isNaN(Date.parse(timing.notBefore as string))) ||
    (timing.mode === 'scheduled' && timing.notBefore === null)
  ) {
    return 'publicationPayload.timing is invalid';
  }
  if (!Array.isArray(payload.evidenceRefs) || !payload.evidenceRefs.every(nonEmptyString)) {
    return 'publicationPayload.evidenceRefs must be an array of references';
  }
  const policy = record(payload.policy);
  if (
    !policy ||
    typeof policy.allowThread !== 'boolean' ||
    !nonEmptyString(policy.duplicatePolicyId) ||
    !nonEmptyString(policy.floodPolicyId)
  ) {
    return 'publicationPayload.policy is invalid';
  }
  return null;
}

/** A pipeline stage (board column). `ownerKind`/`owner` drive agent claim routing (docs/01, docs/04). */
/**
 * The longest a stage's standing rule may be, matching `Stage.instructions` in
 * `@superpipeline/contract`. A rule is a few lines an agent reads every time; past this it is
 * a document, and a document belongs in a card reference where it can be read once.
 */
/**
 * A change to ONE stage. Absent means "leave it"; `null` on `instructions` means "remove it".
 *
 * `key` and `order` are deliberately not patchable. A key is the stage's identity — every card
 * refers to it — and reordering one stage is a statement about all of them, so both remain
 * whole-pipeline work where their consequences are visible.
 */
export interface StagePatch {
  name?: string;
  owner?: string;
  ownerKind?: 'capability' | 'agent' | 'human';
  requires?: { all?: string[]; any?: string[] } | null;
  gate?: 'none' | 'approval';
  wipLimit?: number | null;
  instructions?: string | null;
  completion?: CompletionRequirement | null;
  /** `null` removes it — the stage stops judging. */
  returnStage?: string | null;
}

export const STAGE_INSTRUCTIONS_MAX = 4000;

/**
 * What is wrong with one stage's own fields, or null.
 *
 * Shared by `setStages` (which replaces the pipeline) and `updateStage` (which patches one), so a
 * rule a patch accepts is a rule a replace would accept too. Two copies of this drift, and the
 * copy that drifts is the one nobody is looking at.
 *
 * Checked HERE rather than only in `@superpipeline/contract` because the routes cast rather than
 * parse: a cap enforced only in the schema is a cap nothing enforces.
 */
/**
 * What is wrong with a completion requirement's SHAPE, or null.
 *
 * Checked on the way in because the evaluator is total: handed `handoff: "url"` instead of
 * `["url"]` it reads a list, finds none, and blocks every run on the stage forever. A rule nothing
 * can satisfy is worse than no rule, and it fails at the far end — on an agent's run — rather than
 * here, where the person who typed it is standing.
 */
export function completionShapeError(c: unknown): string | null {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) {
    return 'completion must be an object';
  }
  const r = c as Record<string, unknown>;
  if (r.handoff !== undefined) {
    if (!Array.isArray(r.handoff) || !r.handoff.every((k) => typeof k === 'string' && k.trim() !== '')) {
      return 'completion.handoff must be a list of non-empty key names';
    }
  }
  if (r.reference !== undefined) {
    if (typeof r.reference !== 'object' || r.reference === null || Array.isArray(r.reference)) {
      return 'completion.reference must be an object naming a provider and/or a sourceType';
    }
  }
  if (r.live !== undefined && (typeof r.live !== 'string' || r.live.trim() === '')) {
    return 'completion.live must name a handoff key';
  }
  return null;
}

export function stageFieldError(s: Pick<StageDef, 'key' | 'wipLimit' | 'instructions'>): string | null {
  if (s.wipLimit !== undefined && (!Number.isInteger(s.wipLimit) || s.wipLimit < 1)) {
    return `stage "${s.key}" needs a WIP limit of at least 1, or none`;
  }
  if (s.instructions !== undefined) {
    // Blank is refused: AgentPod gives instructions their own heading, and a heading with nothing
    // under it reads to an agent as "there was nothing to do here", which is a different claim
    // from "this was not provided".
    if (typeof s.instructions !== 'string' || s.instructions.trim() === '') {
      return `stage "${s.key}" has empty instructions — leave them out instead`;
    }
    if (s.instructions.length > STAGE_INSTRUCTIONS_MAX) {
      return `stage "${s.key}" has ${s.instructions.length} characters of instructions; the limit is ${STAGE_INSTRUCTIONS_MAX}. A rule this long is a document, and belongs in a reference.`;
    }
  }
  return null;
}

export interface StageDef {
  key: string;
  name: string;
  order: number;
  ownerKind?: 'capability' | 'agent' | 'human';
  owner?: string; // a capability tag (ownerKind=capability) or an agentId (ownerKind=agent)
  /**
   * A multi-capability requirement for a capability lane: `all` every member, `any` at least one.
   * Wins over `owner` when present. A sibling field rather than a union on `owner` because
   * SQLite's `json_each` raises on a scalar, so widening `owner` would break `boardCount` on
   * every stage that already exists (see `StageRequirement` in @superpipeline/contract).
   */
  requires?: { all?: string[]; any?: string[] };
  gate?: 'none' | 'approval';
  /** Opts this human gate into immutable, digest-bound approval subjects. */
  approvalSubjectSchema?: string;
  /** Human principals allowed to decide a bound approval subject. */
  approvalDeciderPrincipalIds?: string[];
  wipLimit?: number;
  /**
   * What a run must produce here before the board believes it finished
   * (`evaluateCompletion` in @superpipeline/contract). Absent means "anything", which is how
   * every stage behaved before this existed.
   */
  completion?: CompletionRequirement;
  /**
   * Where a run's `outcome: 'changes-needed'` sends the card — an earlier stage's key
   * (`returnStageError` in @superpipeline/contract). Declaring it makes this a judging stage: a
   * completion here must say `pass` or `changes-needed`, and silence is refused. Absent, the stage
   * behaves exactly as it did before outcomes existed.
   */
  returnStage?: string;
  /**
   * The stage's standing rule, handed to the agent in its prompt. A stage's, never a card's:
   * it governs every card that reaches the stage and every agent that can claim it.
   *
   * It reached agents before this line existed, because `setStages` stores whatever it is
   * given and `stages()` parses it straight back. Declared so that stays true on purpose.
   */
  instructions?: string;
  /** Stage routing strategy (docs/05 §7): `pipeline` (sequential handoff, default) vs `manager`. */
  routing?: 'pipeline' | 'manager';
}

/**
 * Canonicalise a stage's routing fields.
 *
 * Both write boundaries — `init` and `setStages` — pass every capability a stage mentions through
 * the one spelling, because routing is exact string equality and a stage typed "Code Review" that
 * stores `Code Review` is a lane no agent can ever claim, with nothing to say why. A requirement
 * that normalises to nothing is dropped, so a stray `{}` from an editor falls back to `owner`
 * rather than becoming a lane nobody can work.
 */
function normalizeStageRouting(s: StageDef): StageDef {
  if (s.ownerKind !== 'capability') return s;
  const out: StageDef = { ...s };
  if (s.owner) out.owner = capabilityTag(s.owner);
  const req = normalizeRequirement(s.requires);
  if (req) out.requires = req;
  else delete out.requires;
  return out;
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

/**
 * Why a card is waiting on a person.
 *
 * `reason` is the discriminator and the only field a reader must handle; the rest are
 * there so the board can say something useful instead of "needs you".
 */
export interface CardNeedsHuman {
  /**
   * Every way a card comes to rest on a person.
   *
   * Five places write `state = 'input-required'` and each one knows why; the first cut
   * of this carried two of them, so a card blocked by its own agent went on reporting
   * the question that block had just cancelled. A card that stops without a reason is
   * one somebody has to reverse engineer from the activity log.
   */
  reason: 'question' | 'repeated-failure' | 'blocked' | 'review' | 'not-authorised';
  /** The question, when there is one to answer. */
  elicitationId?: string;
  /** The run's own words for why it failed. Never summarised. */
  detail?: string;
  /** How many attempts have failed, when the breaker tripped. */
  failureCount?: number;
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
  /**
   * The AGENT that queued this card, when one did — superpipeline's own `agt_…`, not a principal.
   *
   * `queuedBy` cannot answer this. It holds one id, a `prn_…` from a plane whose directory lives
   * in another product, and nothing about the string says whether a person or a coordinator wrote
   * it. Null means a human queued it, which is every card that existed before this column.
   *
   * It is stored rather than derived because the derivation would be a join nobody owns: the
   * agent row can be deleted, renamed or unmapped, and the card still has to be able to say who
   * asked for it. An audit trail that forgets is one that credits the operator with work they
   * never requested.
   */
  queuedByAgentId: string | null;
  /** What the queuer was permitted to dispatch, as granted when they queued it. */
  queuedGrant: string[] | null;
  /** Applied label ids; the catalogue lives in D1 (`src/db/labels.ts`). */
  labels: string[];
  /**
   * Cross-board project/milestone membership (D1 catalogue, migration 0013; Task 19). Either may
   * point at a project/milestone this tenant has since deleted — `DELETE /v1/projects/:id` deletes
   * unconditionally, and this DO has no way to be told. That is a normal state, not an error: an
   * unresolved id is treated exactly like an unknown label id, dropped from display and never a
   * refusal here or in the rollup.
   */
  projectId: string | null;
  milestoneId: string | null;
  /** ISO date (no time), or null. */
  dueAt: string | null;
  /**
   * Why this card is waiting on a person, when it is. Absent whenever it is not —
   * so a reader that does nothing with it behaves exactly as it does today.
   */
  needsHuman?: CardNeedsHuman;
  archivedAt: string | null;
  currentStageKey: string;
  state: TaskState;
  delegateAgentId: string | null;
  /**
   * The run currently holding this card, or null when nobody is working it.
   *
   * On the row since runs existed and never projected. Exposed so a caller that must attribute
   * something to "the run working this card" — an agent attaching evidence mid-run — can do it
   * without being handed a run id it could have made up.
   */
  currentRunId: string | null;
  priority: number;
  contextId: string;
  createdAt: string;
  updatedAt: string | null;
  /** When the card last changed state or stage — how long it has sat where it is. */
  stateSince: string;
  /** Summed agent usage on this card (docs/07 §6); `overBudget` if it exceeds the per-card cap. */
  costUsd: number;
  overBudget: boolean;
  /** Number of runs (attempts) against this card (docs/07 §5). */
  attemptCount: number;
  /**
   * This card's `parent` edge (`card_links`, this card as `to_card_id`), or null if it has none.
   * Task 14.
   */
  parentCardId: string | null;
  /**
   * How many of this card's direct children (the `parent` edge, this card as `from_card_id`) are
   * still unresolved — the same rule `blockedWhere`/`openChildCount` enforce at claim time, surfaced
   * here so a reader (Task 17's UI) can say "waiting on N sub-tasks" without re-deriving it. Task 14.
   */
  openChildCount: number;
  /**
   * `costUsd` plus one level of children's summed cost. Deliberately NOT folded into `costUsd`
   * itself: `costUsd` feeds `overBudget`, the per-card budget gate, and must keep meaning "what
   * this card itself spent". Task 14.
   */
  costUsdRollup: number;
  /**
   * Is this card held back by an unresolved same-board `blocks` edge — the enforced kind?
   *
   * Derived from the SAME `blockedWhere()` fragment the claim query uses (`unresolvedBlockerExists`,
   * Task 17), never from a second expression that means the same thing today. A badge computed
   * independently is a badge that will eventually disagree with the claim query, and the
   * disagreement is invisible: the UI says "Blocked" while `claim_card` hands the card out, or the
   * reverse. This plan has already had one claim/discovery divergence from exactly that cause.
   *
   * An array rather than a boolean because the tooltip has to name the blocker ("Blocked by
   * *Title*"), and a count alone would send the drawer back for another round trip.
   *
   * Only the `blocks` half of `blockedWhere()` — an open child (the `parent` half) is a different
   * fact with a different badge, already carried as `openChildCount`. Cross-board advisory edges
   * (Task 16) are never in here either: they block nothing, and this field name is exactly how a
   * client would end up rendering the enforced badge for an advisory edge.
   */
  blockedBy: Array<{ cardId: string; title: string }>;
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
  /**
   * The card's comments as of this read: the newest `RUN_CONTEXT_COMMENTS` that are not deleted,
   * oldest first, cut short further if their bodies pass `RUN_CONTEXT_COMMENT_BYTES`. Read here
   * by the agent at claim time, and again whenever it re-reads its run — which is how a remark
   * a person adds mid-run reaches it.
   */
  comments: CommentView[];
  /** How many live comments are older than the ones carried — readable in full via the comments route or MCP tool. */
  commentsOmitted: number;
}

/** A remark on a card by a person or by the agent working it. Append-only; never edited. */
export interface CommentView {
  id: string;
  cardId: string;
  author: {
    kind: 'human' | 'agent';
    /** A user id for a person, an `agt_…` for an agent. */
    id: string;
    /** The display name at the time of posting, when one was known. */
    name: string | null;
  };
  /** Markdown source as written, stored and returned as text — a reader must never interpret it as HTML. Empty once deleted. */
  body: string;
  createdAt: string;
  /** Set when the author deleted it; the row stays so the thread still shows a comment was there. */
  deletedAt: string | null;
}

/** The largest comment body, in UTF-8 bytes. */
export const COMMENT_MAX_BYTES = 8192;
/** How many comments, and how many bytes of them, a run context carries at most. */
export const RUN_CONTEXT_COMMENTS = 20;
export const RUN_CONTEXT_COMMENT_BYTES = 16384;

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
  /** The completion verdict, when the stage asked for something. Null when it asked for nothing. */
  completion: Record<string, unknown> | null;
  /**
   * What THIS run handed on. Null when it failed, or when it completed with nothing to say.
   *
   * The card's `handoff` is one value overwritten at every stage, so it only ever shows the latest.
   * This is per-run, which is what lets a reader see the account stage by stage rather than the last
   * line of it.
   */
  handoff: JsonValue | null;
  /** Why this run died, when it did. Null for a run that completed or is still open. */
  failureReason: string | null;
}

/** A gate as evidence (contract C4): decisions in past tense, the run it judged, nothing else. */
export interface RunEvidenceGate {
  id: string;
  run_id: string | null;
  stage_key: string;
  status: 'pending' | 'resolved' | 'cancelled';
  decision: 'approved' | 'changes_requested' | 'rejected' | null;
  decided_by: string | null;
  produced_by: string;
  /** `prn_…` or null. Filled by the Worker (`index.ts` runEvidence): only it can read the catalog. */
  produced_by_principal_id: string | null;
  /** `prn_…` or null. Filled by the Worker (`index.ts` runEvidence): only it can read the catalog. */
  decided_by_principal_id: string | null;
  /** Hub token `sub` the decider is known by, set only when `decided_by_principal_id` is null. Filled by the Worker. */
  decided_by_hub_sub: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** `GET /v1/boards/:id/runs/:runId/evidence` (superwitness contract C4). snake_case: it is a cross-product wire shape. */
export interface RunEvidence {
  run: {
    id: string; board_id: string; card_id: string; stage_key: string; agent_id: string;
    /** `prn_…` or null. Filled by the Worker (`index.ts` runEvidence): only it can read the catalog. */
    agent_principal_id: string | null;
    status: string; outcome: string | null; started_at: string; ended_at: string | null;
  };
  card: { id: string; title: string; stage_key: string };
  gates: RunEvidenceGate[];
  usage:
    | { status: 'reported'; input_tokens: number; output_tokens: number; cost_usd: number }
    | { status: 'unreported'; input_tokens: null; output_tokens: null; cost_usd: null };
  as_of: string;
}

const EVIDENCE_DECISION: Record<string, RunEvidenceGate['decision']> = {
  approve: 'approved',
  approve_manual: 'approved',
  approve_automatic: 'approved',
  request_changes: 'changes_requested',
  reject: 'rejected',
};

function isApproveDecision(decision: GateDecision): boolean {
  return decision === 'approve' || decision === 'approve_manual' || decision === 'approve_automatic';
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

// Defined in `@superpipeline/contract` — it is a cross-repo contract value that
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
  /**
   * What is being approved: the readable part of the card's handoff (`handoffSummary`). On the
   * board snapshot's pending gates only, so a list can say what a decision is about without
   * deciding blind. Plain text — a reader must render it as text.
   */
  summary?: string | null;
  /** Present only for an opt-in digest-bound gate; loaded from immutable subject storage. */
  approvalSubject?: ApprovalSubjectView;
  /** Human-selected delivery state for a resolved immutable publishing approval. */
  delivery?: {
    mode: 'manual' | 'automatic';
    liveUrl: string | null;
    readBackStatus: 'not_checked' | 'matched' | 'mismatch';
    recordedBy: string | null;
    recordedAt: string | null;
  };
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
  /**
   * What the board is CALLED, as opposed to what it is keyed by.
   *
   * Carried because the hub cannot find out any other way: its only route to board
   * metadata resolves a user session, which a service credential does not have — the
   * same wall that makes the hub's `humansFor` an injected dependency. Without this
   * every board's chat room was named after the product rather than the board, so a
   * person with four boards saw four rooms with one name.
   *
   * Always present, empty string when the board has no name, never absent: a reader
   * distinguishing "no name" from "a build that does not send one" would be
   * distinguishing two things that call for the same fallback.
   */
  boardName: string;
  cardId: string;
  gateId: string;
  stageKey: string;
  returnStageKey: string;
  cardTitle: string;
  producedBy: string;
  /** What the reviewer is being asked to approve; null for generic handoff-free gates. */
  handoffSummary: string | null;
  /** Immutable metadata for a digest-bound gate; canonical payload stays behind the authenticated route. */
  approvalSubject?: Pick<ApprovalSubjectView, 'id' | 'digest' | 'schema' | 'revision'>;
  /** Authenticated web route for reviewing the authoritative subject. */
  reviewUrl?: string;
  options: Array<{ id: string; label: string }>;
  /** When the gate opened. The gate's own clock, so a re-read is byte-identical. */
  ts: string;
}

/**
 * What an `elicitation.pending` carries — an agent is blocked on a person.
 *
 * The mirror of {@link GatePendingBody}, and deliberately so: both are "a human must
 * answer something before this card moves", both travel by push and are read back by a
 * sweep, and one builder serves both paths for the reason given above.
 *
 * It exists because nothing outside the web app could previously learn that a run had
 * stopped to ask. `openElicitation` emitted an internal event and filed an in-app
 * notification; neither leaves the board. Every permission prompt therefore meant
 * opening a browser, however the operator was carrying the question around.
 */
export interface ElicitationPendingBody {
  event: 'elicitation.pending';
  boardId: string | null;
  boardName: string;
  cardId: string;
  cardTitle: string;
  elicitationId: string;
  runId: string;
  stageKey: string;
  /**
   * The agent that is waiting — and, at the answer route, the one identity that may
   * not answer. Carried so a projection can say who is blocked rather than just that
   * something is.
   */
  agentId: string;
  /** The question. May be empty: an agent can stop on options alone. */
  question: string;
  /**
   * The options the agent offered, in the order it offered them.
   *
   * **May be empty, and the body is still sent.** An elicitation with no options cannot
   * be answered with a button, and a reader needs to know one exists in order to say
   * where it CAN be answered. Omitting the unanswerable case would make silence mean
   * both "no question" and "a question you cannot tap".
   *
   * `id`/`label`, not the board's `name`/`title`, for the same reason the gate's are.
   */
  options: Array<{ id: string; label: string }>;
  /** When the question was asked. The row's own clock, so a re-read is byte-identical. */
  ts: string;
}

/** A recurring card, and the cadence that fires it (spec §3.7). */
export interface ScheduleView {
  id: string;
  enabled: boolean;
  title: string;
  spec: JsonValue;
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
  /**
   * The human who declared this schedule, and — via `createCardFromTrigger`'s `ownerUserId` —
   * the owner every card it mints inherits. Exposed so a client can show whose cards a schedule
   * will create; before this it was validated hard at creation but invisible everywhere after.
   */
  createdBy: string | null;
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
  /**
   * The run that attached this, when an agent did it mid-run.
   *
   * NULL for a reference a human added, and for every reference attached before this column existed.
   * `addedBy` already said 'agent' or 'user'; it never said WHICH agent or WHEN, so "what did the
   * audit stage attach" was unanswerable even though the references were all still here.
   */
  runId: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface ReferenceInput {
  cardId: string;
  url: string;
  /** The run attaching it, when an agent is. Omitted by a human path, and NULL is the honest value. */
  runId?: string | null;
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

/** A stored edge (spec §3.4) — `LinkRow` plus the provenance columns the DO adds. */
export interface LinkView {
  fromCardId: string;
  toCardId: string;
  kind: LinkKind;
  createdAt: string;
  createdBy: string | null;
}

export interface LinkInput {
  fromCardId: string;
  toCardId: string;
  kind: LinkKind;
  createdBy?: string | null;
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
  /** The board's stale-card settings: how long a card may sit before it counts, and whether the digest is on. */
  stale: StaleSettings;
}

/** Per-board stale-card settings. Defaults: on, 24 hours. */
export interface StaleSettings {
  enabled: boolean;
  afterHours: number;
}

/** The default threshold, in hours, past which a waiting card counts as stale. */
export const STALE_DEFAULT_HOURS = 24;
/** The digest tells an owner about the same card at most once in this long. */
const STALE_DIGEST_REPEAT_MS = 24 * 3600_000;

/**
 * A card that is waiting and will go on waiting unless somebody acts.
 *
 * `why` is one of: waiting on a person (`needs-human`, with the card's own reason, or one derived
 * for the two parks that predate `needsHuman` — a review gate opened on entry, and a parent held
 * back by open sub-tasks), or sitting in a stage nothing will ever take it from (`no-owner`: not
 * agent-claimable, no approval gate, and not the last stage — which resolves a card on arrival).
 */
export interface StaleCardView {
  boardId: string;
  boardName: string;
  cardId: string;
  title: string;
  ownerUserId: string;
  stageKey: string;
  stageName: string;
  state: TaskState;
  why:
    | { kind: 'needs-human'; reason: CardNeedsHuman['reason'] | 'sub-tasks'; detail?: string; failureCount?: number; elicitationId?: string; gateId?: string }
    | { kind: 'no-owner' };
  /** The readable part of the card's handoff (`handoffSummary`) — what a reviewer is asked to approve. Plain text, never HTML. */
  summary: string | null;
  /** When the card stopped where it is (ISO). */
  since: string;
  ageHours: number;
  /** What a person should do next, in words, with the command when there is one. */
  next: string;
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
      /**
       * Why the LAST attempt at this stage died, when there was one.
       *
       * The agent about to repeat the work was the only party not told. The human got a
       * notification, the event stream got an event, the dead run kept a label — and the retry
       * started from a card indistinguishable from the one the first attempt saw. An agent that
       * knows "the browser could not start last time" can do something different; one that does not
       * walks into the same wall until the circuit breaker parks the card.
       *
       * Scoped to THIS stage. A failure at `audit` tells an agent claiming `audit` something; handed
       * to one claiming `measure` it would read as "your work has already failed once" about work
       * that has not started. Null when the last run here succeeded, or when there was none.
       */
      lastFailure: { reason: string; agentId: string; stageKey: string; endedAt: string } | null;
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
  | 'INVALID_APPROVAL_SUBJECT'
  | 'APPROVAL_DECIDER_NOT_ALLOWED'
  | 'APPROVAL_SUBJECT_MISMATCH'
  | 'APPROVAL_SUBJECT_NOT_VERIFIED'
  | 'APPROVAL_SUBJECT_EXPIRED'
  | 'APPROVAL_DELIVERY_NOT_AVAILABLE'
  | 'APPROVAL_DELIVERY_NOT_MANUAL'
  | 'APPROVAL_DELIVERY_STARTED'
  | 'INVALID_APPROVAL_DELIVERY'
  | 'INVALID_LIVE_URL'
  | 'ELICITATION_NOT_FOUND'
  | 'ELICITATION_NOT_PENDING'
  | 'INVALID_ANSWER'
  | 'CARD_NOT_WAITING'
  | 'SEPARATION_OF_DUTIES'
  | 'INVALID_URL'
  | 'UNKNOWN_EVENT'
  | 'INVALID_SIGNATURE'
  | 'NOT_CONFIGURED'
  | 'INVALID_DELIVERY'
  | 'INVALID_USAGE'
  | 'INVALID_STAGES'
  | 'STAGE_NOT_EMPTY'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_RULE'
  | 'INVALID_TIMEZONE'
  | 'SCHEDULE_NOT_FOUND'
  | 'INVALID_SCHEDULE'
  | 'NO_SUCH_CARD'
  | 'LINK_WOULD_CYCLE'
  | 'ALREADY_HAS_PARENT'
  | 'CARD_BLOCKED'
  | 'TOO_MANY_CHILDREN'
  | 'NOTHING_TO_SPLIT'
  | 'INVALID_COMMENT'
  /** `complete` named an outcome without what it needs (`outcomeInputError`), or no outcome at all. */
  | 'INVALID_OUTCOME'
  | 'COMMENT_NOT_FOUND'
  | 'NOT_COMMENT_AUTHOR'
  | 'NO_RUN_ON_CARD'
  | 'CARD_CHANGED'
  | 'INVALID_RESUME'
  | 'QUESTION_PENDING'
  | 'GATE_PENDING'
  | 'INVALID_STALE_SETTINGS';

export type Result<T> = { ok: true; value: T } | { ok: false; code: BoardErrorCode; message: string };

/** One superwitness outbox row (superwitness app spec §3.5), as `getRunReportOutbox` returns it. */
export interface RunReportOutboxRow {
  runId: string;
  gen: number;
  status: 'pending' | 'dead';
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  reportedAt: string;
  draft: RunReportDraft;
}

export interface RunReportDrainResult {
  sent: number;
  retried: number;
  parked: number;
}

/** The Board DO's RPC surface as the Worker calls it — hand-typed to avoid deep RPC type instantiation. */
export interface BoardStub {
  drainRunReports(): Promise<RunReportDrainResult>;
  enqueueAllRunReports(): Promise<Result<{ enqueued: number; pending: number; dead: number }>>;
  init(board: BoardInit): Promise<BoardSnapshot>;
  createCard(input: {
    /** What the queuer was permitted to dispatch, as granted at this moment. */
    queuedGrant?: string[] | null;
    /** The principal who dispatched it, when that is not the owner (the agent case). */
    queuedBy?: string | null;
    /** The agent that queued it, if an agent did. */
    queuedByAgentId?: string | null;
    title: string;
    ownerUserId: string;
    spec?: JsonValue;
    priority?: number;
    dueAt?: string;
  }): Promise<Result<CardView>>;
  /** Split a card into a sub-task: a claimable card of its own, linked back with a `parent` edge. */
  createChildCard(
    parentCardId: string,
    input: { title: string; ownerUserId: string; spec?: JsonValue; priority?: number },
  ): Promise<Result<CardView>>;
  /**
   * Split a card into several children at once, one per (non-blank) line — the agent-facing
   * decomposition tool (Task 15, spec §3.4). `actorUserId` becomes each child's `ownerUserId`.
   *
   * `agentId`, when supplied, must be the agent whose run currently holds `cardId`
   * (`CardView.delegateAgentId`) or the call refuses `NOT_RUN_OWNER` — "the card you are working
   * on" enforced, not just described. Omitted (`undefined`/`null`) for the human/REST path, which
   * has no run to check against.
   */
  splitCard(cardId: string, titles: string[], actorUserId: string, agentId?: string | null): Promise<Result<{ children: CardView[] }>>;
  moveCard(
    cardId: string,
    toStageKey: string,
    actorUserId?: string,
    /** What the mover was permitted to dispatch, recorded with the card. */
    queuedGrant?: string[] | null,
    /**
     * The AGENT doing the moving, when one is. A move re-queues the card, so the pair
     * `queued_by`/`queued_by_agent_id` must move together here exactly as on a create — otherwise a
     * card an agent re-queued reads as the operator's, or one a HUMAN re-queued keeps crediting the
     * agent that queued it first.
     */
    queuedByAgentId?: string | null,
  ): Promise<Result<CardView>>;
  /** One card, in the same projection the board snapshot carries. */
  getCardView(cardId: string): Promise<Result<CardView>>;
  updateCard(
    cardId: string,
    patch: {
      title?: string;
      spec?: JsonValue;
      priority?: number;
      ownerUserId?: string;
      labels?: string[];
      dueAt?: string | null;
      archivedAt?: string | null;
      /** Cross-board project/milestone membership (Task 19). `null` clears it. */
      projectId?: string | null;
      milestoneId?: string | null;
      /** A precondition: the card's `updatedAt` as last read; a mismatch refuses `CARD_CHANGED`. */
      expectedUpdatedAt?: string | null;
    },
  ): Promise<Result<CardView>>;
  deleteCard(cardId: string): Promise<Result<{ ok: true }>>;
  setName(name: string): Promise<Result<{ ok: true }>>;
  setStages(stages: StageDef[]): Promise<Result<{ stages: StageDef[] }>>;
  updateStage(stageKey: string, patch: StagePatch): Promise<Result<{ stage: StageDef }>>;
  destroy(): Promise<{ ok: true }>;
  getState(): Promise<BoardSnapshot>;
  getEvents(limit?: number): Promise<BoardEvent[]>;
  // Agent contract (docs/04 §3)
  claim(input: { agentId: string; capabilities: string[]; maxConcurrency?: number; profileKey?: string; principalId?: string | null }): Promise<ClaimResult>;
  setProfile(input: ProfileInput): Promise<Result<{ key: string }>>;
  getProfiles(): Promise<ProfileView[]>;
  heartbeat(input: RunVerbInput): Promise<Result<{ acknowledged: true }>>;
  postActivity(input: AgentActivityInput): Promise<Result<{ accepted: true; cardState: TaskState }>>;
  complete(input: CompleteVerbInput): Promise<Result<CardView>>;
  block(input: RunVerbInput & { reason: string }): Promise<Result<CardView>>;
  fail(input: RunVerbInput & { reason: string }): Promise<Result<CardView>>;
  release(input: RunVerbInput & { reason?: string }): Promise<Result<CardView>>;
  submitForReview(input: RunVerbInput & { output?: JsonValue }): Promise<Result<CardView>>;
  addReference(input: ReferenceInput): Promise<Result<ReferenceView>>;
  /** Dependencies and sub-task containment (spec §3.4) — one table, told apart by `kind`. */
  addLink(input: LinkInput): Promise<Result<LinkView>>;
  removeLink(fromCardId: string, toCardId: string, kind: LinkKind): Promise<Result<{ ok: true }>>;
  listLinks(cardId: string): Promise<LinkView[]>;
  setBudget(input: { boardUsdCap?: number | null; cardUsdCap?: number | null }): Promise<Result<{ ok: true }>>;
  getUsage(opts?: { window?: string }): Promise<UsageSummary>;
  /**
   * This board's slice of one project's rollup (Task 19) — the one fan-out in this design.
   * `computeRollup` (`db/projects.ts`) calls this on every board a tenant has and sums the
   * results; it is never consulted by the claim path, the advance path, or any refusal.
   * `{ ok: false }` when the board has no `boardId` meta, i.e. its DO was never initialized — see
   * the implementation's own comment for why that is a `Result` rather than a thrown exception.
   * `computeRollup` turns either that or a genuinely thrown error into `partial: true` plus an
   * unanswered-board count, never a confident wrong total.
   */
  projectSummary(projectId: string): Promise<Result<{ total: number; done: number; overdue: number; costUsd: number }>>;
  getAttempts(cardId: string): Promise<AttemptView[]>;
  getRunContext(input: { runId: string; agentId?: string | null }): Promise<Result<RunContext>>;
  /** A card's comments, oldest first, deleted ones as tombstones. */
  listComments(cardId: string): Promise<Result<CommentView[]>>;
  /**
   * Post a comment. An `agent` author must hold a live (`working`) run on the card, or the call
   * refuses `NO_RUN_ON_CARD`: an agent talks on the card it is working, and nowhere else.
   */
  addComment(input: { cardId: string; author: CommentView['author']; body: string }): Promise<Result<CommentView>>;
  /** Return a card waiting on a person to its stage (or an earlier one) with a comment — see the method. */
  resumeCard(input: {
    cardId: string;
    comment: string;
    toStageKey?: string;
    actor: { id: string; name: string | null };
    queuedGrant?: string[] | null;
  }): Promise<Result<{ card: CardView; comment: CommentView }>>;
  /** Tombstone a comment. Only its human author may; an agent's comment is never deleted. */
  deleteComment(input: { cardId: string; commentId: string; userId: string }): Promise<Result<CommentView>>;
  /** The comments on the card a run holds, for that run's agent (the MCP list tool). */
  listRunComments(input: { runId: string; agentId: string | null }): Promise<Result<CommentView[]>>;
  /** Post as the agent holding `runId`, on that run's card (the MCP post tool). */
  addRunComment(input: { runId: string; agentId: string; agentName: string | null; body: string }): Promise<Result<CommentView>>;
  verifyApprovalSubject(input: {
    runId: string;
    leaseEpoch: number;
    agentId?: string | null;
    expectedSchema: string;
    expectedSubjectId: string;
    expectedDigest: string;
    expectedAccount: JsonValue;
  }): Promise<Result<ApprovalSubjectVerification>>;

  /** A run as evidence for superwitness (contract C4). `NOT_INITIALIZED` means no such board here. */
  getRunEvidence(runId: string): Promise<Result<RunEvidence>>;
  countReadyForCapabilities(agentId: string, capabilities: string[]): Promise<number>;
  /** One gate, including how it was decided. See `getGate`. */
  getGate(gateId: string): Promise<Result<GateView>>;
  getCardActivities(cardId: string): Promise<{ activities: ActivityView[]; handoff: JsonValue | null; gates: GateView[] }>;
  getEvents(limit?: number): Promise<BoardEvent[]>;
  estimateCardCost(cardId: string): Promise<Result<EstimateView>>;
  getNotifications(opts?: { unreadOnly?: boolean; userId?: string }): Promise<NotificationView[]>;
  markNotificationRead(seq: number): Promise<Result<{ ok: true }>>;
  registerPushConfig(input: PushConfigInput): Promise<Result<{ configId: string }>>;
  getPushDeliveries(opts?: { status?: string }): Promise<PushDeliveryView[]>;
  pendingGateDeliveries(): Promise<GatePendingBody[]>;
  pendingElicitationDeliveries(): Promise<ElicitationPendingBody[]>;
  dispatchPushDeliveries(sender?: PushSender, opts?: { timeoutMs?: number }): Promise<{ sent: number; failed: number }>;
  getRunReportOutbox(): Promise<RunReportOutboxRow[]>;
  sweepBoard(nowIso: string): Promise<{ overdueNotified: number; schedulesFired: number; staleNotified: number }>;
  /** Cards waiting past the threshold — the board's own unless `afterHours` is given. See `StaleCardView`. */
  staleCards(input: { nowIso: string; afterHours?: number; attention?: boolean }): Promise<StaleCardView[]>;
  setStaleSettings(input: { enabled?: boolean; afterHours?: number }): Promise<Result<StaleSettings>>;
  createSchedule(input: {
    title: string;
    rule: string;
    timezone: string;
    overlap: 'skip' | 'allow';
    createdBy: string;
    spec?: JsonValue;
    priority?: number;
    labels?: string[];
    stageKey?: string | null;
    enabled?: boolean;
    /** What the creator was permitted to dispatch, captured at the moment of the act. */
    queuedGrant?: string[] | null;
  }): Promise<Result<ScheduleView>>;
  updateSchedule(
    id: string,
    patch: {
      title?: string;
      rule?: string;
      timezone?: string;
      overlap?: 'skip' | 'allow';
      spec?: JsonValue;
      priority?: number;
      labels?: string[];
      stageKey?: string | null;
      enabled?: boolean;
    },
  ): Promise<Result<ScheduleView>>;
  deleteSchedule(id: string): Promise<Result<{ id: string }>>;
  listSchedules(): Promise<ScheduleView[]>;
  setGithubSecret(secret: string): Promise<Result<{ configured: true }>>;
  setForgeSecret(secret: string): Promise<Result<{ configured: true }>>;
  handleForgeWebhook(input: {
    rawBody: string;
    signature: string | null;
    deliveryId: string | null;
    event: string;
  }): Promise<Result<{ deduped: boolean; matched: number; modeled: boolean }>>;
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
    approvalSubjectId?: string;
    approvalSubjectDigest?: string;
  }): Promise<Result<CardView>>;
  updateApprovalDelivery(input: {
    gateId: string;
    actor: string;
    mode?: 'manual' | 'automatic';
    liveUrl?: string;
  }): Promise<Result<CardView & { delivery: NonNullable<GateView['delivery']> }>>;
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
 * `complete`, with the kind of finish it is (`StageOutcome` in @superpipeline/contract).
 *
 * Every field past `handoff` is optional and absent on every caller that predates outcomes, which
 * then behaves exactly as before — except on a stage that declares a `returnStage`, where silence
 * is no longer read as a pass.
 */
export interface CompleteVerbInput extends RunVerbInput {
  handoff?: JsonValue;
  outcome?: StageOutcome;
  findings?: string;
  question?: string;
  url?: string;
  options?: JsonValue;
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
const defaultPushSender: PushSender = (url, init) => fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(PUSH_TIMEOUT_MS) }).then((r) => ({ status: r.status }));

export class BoardDO extends DurableObject<Env> {
  private sql: SqlStorage;
  /** The run reporter's hub token, in memory only (ruling R14). */
  private readonly reporterToken = new ServiceTokenCache();
  /** One drain at a time: the alarm and the cron backstop can both ask. */
  private reportDrain: Promise<RunReportDrainResult> | null = null;

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
     * The completion verdict, so a trace can say WHY a run ended as it did.
     *
     * Without it the receipt could only report `completed` or `blocked` and had to guess at the
     * rest — which is how a published trace came to record a publish run that had refused. It also
     * carries `override` and `unchecked`, because a waived check and an unverifiable one are both
     * things a reader must be able to see.
     */
    try {
      this.sql.exec(`ALTER TABLE runs ADD COLUMN completion TEXT`);
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
    /**
     * Which agent queued the card, as distinct from which principal authorised it.
     *
     * Guarded ALTER, like `queued_by` above: every existing card reads NULL, which is exactly
     * right — all of them were queued by a person.
     */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN queued_by_agent_id TEXT`);
    } catch {
      // column already exists
    }
    /**
     * What this run handed on, and why it died — kept on the RUN rather than only on the card.
     *
     * `cards.handoff_json` is one column, overwritten by every `complete()`, so stage N+1 destroyed
     * stage N's handoff the moment the card advanced. And `fail()` stored a LABEL
     * (`outcome = 'crashed'`) while the reason went to a human's notification and the event stream —
     * never to the agent about to repeat the work.
     *
     * The card's copy is unchanged: it is the live INPUT the next claim reads. These are the record.
     */
    try {
      this.sql.exec(`ALTER TABLE runs ADD COLUMN handoff_json TEXT`);
    } catch {
      // column already exists
    }
    try {
      this.sql.exec(`ALTER TABLE runs ADD COLUMN failure_reason TEXT`);
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
     * When this run's REPORTED state last changed — superwitness's `reported_at` (superwitness app
     * spec §3.5: "the run row's own update timestamp"). Strictly increasing per run (`reportRun`).
     * Nullable: rows from before this column read NULL, and the backfill reports them at
     * COALESCE(updated_at, ended_at, started_at). Heartbeats do not touch it.
     */
    try {
      this.sql.exec(`ALTER TABLE runs ADD COLUMN updated_at TEXT`);
    } catch {
      // column already exists
    }
    /**
     * The superwitness run-report outbox (superwitness app spec §3.5), the same pattern as
     * `push_deliveries`. One row per run holding its LATEST snapshot; `gen` counts upserts so a
     * drain that sent an older snapshot never deletes a newer one. `status` is `pending` or `dead`
     * (parked); `next_attempt_at` is epoch ms.
     */
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS run_reports (
        run_id TEXT PRIMARY KEY,
        gen INTEGER NOT NULL DEFAULT 1,
        report_json TEXT NOT NULL,
        reported_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_run_reports_due ON run_reports(status, next_attempt_at)`);
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
    /** Applied label ids (D1 catalogue, migration 0010). JSON array; ids, not names. */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      // column already exists
    }
    /**
     * A due date, promoted out of `spec.due`.
     *
     * A date, not a timestamp — that is what the UI has always written, and inventing a time of
     * day would make every existing value wrong by up to a day.
     */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN due_at TEXT`);
    } catch {
      // column already exists
    }
    /**
     * When the owner was last told this card is overdue. Internal to the sweep and deliberately
     * absent from `CardView`: a five-minute cron tick with nothing to remember would notify on
     * every tick forever.
     */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN overdue_notified_at TEXT`);
    } catch {
      // column already exists
    }
    /** Archived cards stay on the board's record and leave its working set. */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN archived_at TEXT`);
    } catch {
      // column already exists
    }
    /**
     * What `advanceCard` would have done, if it had not found this card held back by an open
     * child: the from-stage, who produced the handoff, and the handoff itself (already a JSON
     * string). Set only while parked (Task 14 step 3); cleared the moment the deferred advance is
     * replayed. Internal, like `overdue_notified_at` above — not on `CardView`. A reader doesn't
     * need the stored from-stage/handoff, only that the card is waiting (`openChildCount > 0`
     * plus `state = 'input-required'` already says that).
     */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN pending_advance_json TEXT`);
    } catch {
      // column already exists
    }
    /**
     * Cross-board project/milestone membership (D1 catalogue, migration 0013; Task 19). A single-DO
     * write, like every other card edit — the project itself, and the rollup that fans out across
     * every board carrying its id, live entirely in D1 and are never consulted here. Either column
     * may point at a project/milestone this tenant has since deleted (`DELETE /v1/projects/:id`
     * deletes unconditionally and cannot reach this DO to clear it); that is a normal state, read
     * straight off the row below exactly like a dangling label id, never checked and never fatal.
     */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN project_id TEXT`);
    } catch {
      // column already exists
    }
    /**
     * WHY this card needs a human, when it does.
     *
     * `input-required` says that one is needed and not what for, and the two reasons
     * want opposite things from the reader: a question wants answering, a tripped
     * circuit breaker wants looking at. Card `a9619fe` sat in `input-required` with no
     * pending elicitation and a handoff reading "Verification is in progress", which to
     * a person is a card demanding input that offers nothing to input.
     *
     * JSON rather than columns because the arms differ — a question carries an id, a
     * failure carries a count and the run's own words — and because this is read, never
     * filtered on. Null whenever the card is not waiting on anybody, which is the
     * normal case and is what every existing reader already assumes.
     */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN needs_human_json TEXT`);
    } catch {
      // column already exists
    }
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN milestone_id TEXT`);
    } catch {
      // column already exists
    }
    /**
     * The one automatic rework this card's current stage visit has already spent, when it has.
     *
     * Set by `complete()` on a first completion refusal (`{ stageKey, reason, runId }`) and read by
     * the next one: a second refusal on the same visit parks the card instead of reworking again.
     * Cleared by the trigger below whenever the card changes stage, and by `resumeCard` — a person
     * sending the card back is a fresh start, and so is a reviewer asking for changes (which moves
     * the card off its review stage and back). Internal; not on `CardView`.
     */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN completion_rework_json TEXT`);
    } catch {
      // column already exists
    }
    /**
     * How many times a judging stage's `changes-needed` has sent this card back on its own since a
     * person last acted on it (`MAX_AUTOMATIC_RETURNS`).
     *
     * Per CARD, not per stage visit like `completion_rework_json`: a return IS a new visit, so a
     * per-visit count would reset on every lap of the fix → judge loop it exists to stop. Nothing
     * automatic resets it — not a later pass, which would let two judges take turns forever — only
     * a person: `resumeCard`, `moveCard`, a reviewer's request-changes. Internal; not on `CardView`.
     */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN auto_returns INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // column already exists
    }
    /**
     * When the card last changed state or stage — how long it has been sitting where it is.
     *
     * Written by a trigger rather than by each writer because there are more than twenty statements
     * in this file that move a card, and a timestamp every one of them must remember to set is a
     * timestamp one of them will forget. It copies the row's own `updated_at`, which every one of
     * those statements already sets, so the trigger holds no clock of its own. NULL on a card that
     * has not moved since this column arrived; readers fall back to `updated_at`, then `created_at`.
     *
     * `stale_notified_at` is the stale digest's memory, like `overdue_notified_at` is the overdue
     * sweep's: the last time this card's owner was told it was stuck. Deliberately NOT reset when the
     * card moves: the promise is "never the same card twice in a day", and a card flapping between
     * two stuck states would otherwise be reported on every flap.
     */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN state_since TEXT`);
    } catch {
      // column already exists
    }
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN stale_notified_at TEXT`);
    } catch {
      // column already exists
    }
    this.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS cards_state_since AFTER UPDATE OF state, current_stage_key ON cards
       WHEN NEW.state IS NOT OLD.state OR NEW.current_stage_key IS NOT OLD.current_stage_key
       BEGIN
         UPDATE cards SET
           state_since = COALESCE(NEW.updated_at, NEW.created_at),
           completion_rework_json = CASE WHEN NEW.current_stage_key IS NOT OLD.current_stage_key
                                         THEN NULL ELSE completion_rework_json END
         WHERE id = NEW.id;
       END`,
    );
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN active_approval_subject_id TEXT`);
    } catch {
      // column already exists
    }
    // Only `project_id` is indexed: `projectSummary` is the one query that filters cards by it,
    // and nothing here looks cards up by `milestone_id` on its own.
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_cards_project ON cards(project_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_cards_due_at ON cards(due_at)`);
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
    /**
     * The run whose work this gate judges (charter -> decisions/2026-09-29-evidence-joins-on-the-
     * work-run.md, decision 4), so a human's rejection can be attributed to the run and the
     * configuration that produced it. Nullable on purpose: gates opened before this column have
     * none, and the evidence route reads a null as "a legacy gate on this card and stage".
     */
    try {
      this.sql.exec(`ALTER TABLE gates ADD COLUMN run_id TEXT`);
    } catch {
      // column already exists
    }
    try {
      this.sql.exec(`ALTER TABLE gates ADD COLUMN approval_subject_id TEXT`);
    } catch {
      // column already exists
    }
    try {
      this.sql.exec(`ALTER TABLE gates ADD COLUMN approval_subject_digest TEXT`);
    } catch {
      // column already exists
    }
    try {
      this.sql.exec(`ALTER TABLE gates ADD COLUMN live_post_url TEXT`);
    } catch {
      // column already exists
    }
    try {
      this.sql.exec(`ALTER TABLE gates ADD COLUMN live_post_url_recorded_by TEXT`);
    } catch {
      // column already exists
    }
    try {
      this.sql.exec(`ALTER TABLE gates ADD COLUMN live_post_url_recorded_at TEXT`);
    } catch {
      // column already exists
    }
    try {
      this.sql.exec(`ALTER TABLE gates ADD COLUMN live_post_readback_status TEXT`);
    } catch {
      // column already exists
    }
    try {
      this.sql.exec(`ALTER TABLE gates ADD COLUMN approval_decider_ids_json TEXT`);
    } catch {
      // column already exists
    }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gates_run ON gates(run_id)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS approval_subjects (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        gate_stage_key TEXT NOT NULL,
        schema TEXT NOT NULL,
        revision INTEGER NOT NULL,
        canonical_bytes BLOB NOT NULL,
        digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'invalidated')),
        producer_run_id TEXT NOT NULL,
        produced_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        invalidated_at TEXT,
        invalidated_by TEXT,
        invalidation_reason TEXT,
        UNIQUE(card_id, schema, revision)
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_approval_subjects_card ON approval_subjects(card_id)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS approval_delivery_events (
        id TEXT PRIMARY KEY,
        gate_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        event TEXT NOT NULL,
        from_mode TEXT,
        to_mode TEXT,
        actor TEXT NOT NULL,
        live_url TEXT,
        created_at TEXT NOT NULL
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_approval_delivery_events_gate ON approval_delivery_events(gate_id)`);
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
    /**
     * Which run attached a reference. NULL means a human did it, or that it predates this column —
     * both honest, and neither invented.
     *
     * Placed AFTER the CREATE above, not with the `runs` migrations: an ALTER that runs before its
     * table exists throws into the guard's catch and is silently skipped, which is exactly what
     * happened on the first attempt — the insert then failed with "no column named run_id" on a
     * migration that looked like it had succeeded.
     */
    try {
      this.sql.exec(`ALTER TABLE card_references ADD COLUMN run_id TEXT`);
    } catch {
      // column already exists
    }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_refs_card ON card_references(card_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_refs_external ON card_references(external_id)`);
    // Dependencies AND sub-task containment, in one table (spec §3.4). Same-board only: an edge
    // that may refuse a claim has to be strongly consistent, which means inside this DO.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS card_links (
        from_card_id TEXT NOT NULL,
        to_card_id   TEXT NOT NULL,
        kind         TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        created_by   TEXT,
        PRIMARY KEY (from_card_id, to_card_id, kind)
      )`,
    );
    // A card has at most one parent.
    this.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS card_links_one_parent ON card_links (to_card_id) WHERE kind = 'parent'`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_card_links_to ON card_links(to_card_id, kind)`);
    // The mirror of idx_card_links_to: the `parent` clause in `blockedWhere`/`openChildCount` (and
    // `notifyDependents`'s `blocks` fan-out) both filter on `from_card_id`, unindexed until now.
    // Negligible with today's card counts; Task 15 starts creating children in bulk.
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_card_links_from ON card_links(from_card_id, kind)`);
    // Inbound webhook delivery dedup (docs/06 §3): GitHub may redeliver the same X-GitHub-Delivery.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS webhook_deliveries (delivery_id TEXT PRIMARY KEY, received_at TEXT NOT NULL)`,
    );
    // Card comments. Append-only: a row is never updated except to tombstone it (`deleted_at`,
    // body cleared), so the thread keeps saying a comment was there and who wrote it.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS card_comments (
        id          TEXT PRIMARY KEY,
        card_id     TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        author_id   TEXT NOT NULL,
        author_name TEXT,
        body        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        deleted_at  TEXT
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_card_comments_card ON card_comments(card_id, created_at)`);
    // Recurring cards (spec §3.7). In the board rather than D1 because a schedule is a property of
    // one board's pipeline, and firing it is a write to this DO.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS schedules (
        id            TEXT PRIMARY KEY,
        enabled       INTEGER NOT NULL DEFAULT 1,
        title         TEXT NOT NULL,
        spec_json     TEXT NOT NULL DEFAULT '{}',
        priority      INTEGER NOT NULL DEFAULT 0,
        labels        TEXT NOT NULL DEFAULT '[]',
        stage_key     TEXT,
        rule          TEXT NOT NULL,
        timezone      TEXT NOT NULL,
        overlap       TEXT NOT NULL DEFAULT 'skip',
        next_fire_at  TEXT NOT NULL,
        last_fired_at TEXT,
        last_card_id  TEXT,
        skip_count    INTEGER NOT NULL DEFAULT 0,
        created_by    TEXT,
        created_at    TEXT NOT NULL,
        queued_grant  TEXT
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(next_fire_at)`);
    /**
     * What the creator was PERMITTED to dispatch, as granted at the moment the schedule was
     * declared — the same reasoning `cards.queued_grant` above already follows, applied one step
     * earlier. Creating a schedule IS the act of authorising unattended dispatch, exactly as
     * wiring a webhook's `triggerGrant` is: there is no human present when the schedule fires
     * later, so the answer to "may this run?" has to be written down now, while it is still
     * askable.
     *
     * Without this column, `fireDueSchedules` had nothing to pass but `undefined`, so
     * `createCardFromTrigger` fell back to `triggerGrant()` — the board's GitHub-webhook grant,
     * which has exactly one writer (`PUT /v1/boards/:id/github`). A board whose operator never
     * saved GitHub settings has `null` there, so under enforcement every scheduled card parked in
     * `input-required` on first claim, forever, and — because that state is not terminal —
     * `scheduleInstanceOpen` read the instance as open forever too, silencing the schedule behind
     * its own default `overlap: 'skip'`. Guarded ALTER, matching the `cards.queued_grant` migration
     * above, because a board's DO may already have a `schedules` table from before this column
     * existed — the `CREATE TABLE IF NOT EXISTS` above only helps a board created fresh.
     */
    try {
      this.sql.exec(`ALTER TABLE schedules ADD COLUMN queued_grant TEXT`);
    } catch {
      // column already exists
    }
  }

  // ----- RPC: board lifecycle -----

  async init(board: BoardInit): Promise<BoardSnapshot> {
    if (!this.getMeta('boardId')) {
      // Same normalisation as `setStages`: a board created with a mis-spelled capability owner is
      // a board whose lane no agent can ever claim from.
      const stages = [...board.stages]
        .map(normalizeStageRouting)
        .sort((a, b) => a.order - b.order);
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
    /**
     * The principal who dispatched this card, when it is not the owner.
     *
     * Defaults to `ownerUserId`, which is what it has always been: a person creating a card is
     * both answerable for it and the authority behind it. An agent-queued card is the case where
     * the two come apart — the human owns it, the agent's principal authorised it — and the
     * control pair checks THIS value at claim time, so conflating them would check the wrong one.
     */
    queuedBy?: string | null;
    /** The agent that queued it, if an agent did. See `CardView.queuedByAgentId`. */
    queuedByAgentId?: string | null;
    title: string;
    ownerUserId: string;
    spec?: JsonValue;
    priority?: number;
    /**
     * Set at creation rather than requiring create-then-patch: a second round trip means a
     * failure between the two silently drops the due date. Validated at the route (same rule as
     * `PATCH /cards/:id`'s `dueAt`), so this DO trusts a bare `YYYY-MM-DD` string.
     */
    dueAt?: string;
    /**
     * NOT part of the public `createCard` surface (`BoardStub`'s own `createCard` doesn't carry
     * it) — `createChildCard` is the one internal caller, passing the parent's `projectId` along
     * (see that method's comment). A generic `POST /cards` taking `projectId` directly is Task
     * 21's, parked deliberately rather than added here.
     */
    projectId?: string | null;
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
        (id, title, spec_json, owner_user_id, current_stage_key, state, priority, context_id, created_at, updated_at, queued_by, queued_by_agent_id, queued_grant, due_at, project_id)
       VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.title,
      JSON.stringify((this.getMeta('dueBackfillDone') ? stripStaleSpecKeys(input.spec) : input.spec) ?? {}),
      input.ownerUserId,
      first.key,
      input.priority ?? 0,
      contextId,
      now,
      now,
      // Creating a card in the first stage IS queueing it: it is claimable the
      // moment it exists, so the creator is the principal who dispatched it —
      // unless the caller names a different one, which is the agent case.
      input.queuedBy ?? input.ownerUserId,
      input.queuedByAgentId ?? null,
      input.queuedGrant ? JSON.stringify(input.queuedGrant) : null,
      input.dueAt ?? null,
      input.projectId ?? null,
    );
    const card = this.mustGetCard(id);
    this.emit('card.created', { card });
    this.notifyWorkAvailable(id);
    return { ok: true, value: card };
  }

  /**
   * Split a card into a sub-task (spec §3.4, Task 14 / 15). A real, independently claimable card —
   * built on `createCard` plus a `parent` edge (`addLink`), not a lighter-weight "checklist item"
   * type.
   *
   * Inherits `priority` (unless the caller overrides it) because a sub-task of an urgent card is
   * itself urgent. Deliberately does NOT inherit `labels` or `dueAt`: a label describes what a card
   * IS, not what its parent is, and a sub-task's own deadline is not its parent's — Linear inherits
   * neither either.
   *
   * `projectId` IS inherited (Task 19 follow-up): a sub-task is part of the same body of work as
   * its parent, so the project follows — without this, decomposing a card would silently shrink
   * the project it belongs to, under-counting both `cardsTotal` and `costUsd` in the rollup, which
   * is exactly the "silently under-counting a project's cost" failure `overBudget` exists to
   * prevent elsewhere. `milestoneId` is deliberately left null, NOT inherited: a milestone is a
   * narrower, dated commitment the PARENT made, and silently enrolling a brand-new child into it
   * would let decomposition inflate a milestone nobody re-committed to.
   *
   * ALSO inherits `queuedGrant` — not optional, not overridable by the caller. The parent's grant
   * IS the authority under which this work exists, the same reasoning `moveCard` already applies
   * when it preserves `queued_grant` across a re-queue. Before this, a child was created with
   * `queued_grant = NULL` — under `ENFORCE_CONTROL_PAIR` that made EVERY child unclaimable, because
   * `grantPermitsAgent(null, …)` is unconditionally false, which silently broke the promise
   * `splitCard`'s tool description makes ("each becomes a real card that can be claimed
   * separately"). Phase 2 shipped the identical bug for scheduled cards (`triggerGrant()` null on a
   * board that had never saved GitHub settings); the fix there was the same shape — record and
   * carry forward the authorising grant rather than leaving a creation path to default to none.
   */
  async createChildCard(
    parentCardId: string,
    input: { title: string; ownerUserId: string; spec?: JsonValue; priority?: number },
  ): Promise<Result<CardView>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    const parent = this.getCard(parentCardId);
    if (!parent) return { ok: false, code: 'NO_SUCH_CARD', message: `card not found: ${parentCardId}` };
    const created = await this.createCard({
      title: input.title,
      ownerUserId: input.ownerUserId,
      spec: input.spec,
      priority: input.priority ?? parent.priority,
      queuedGrant: parent.queuedGrant,
      // Same reasoning one step further: a sub-task of a card the coordinator asked for was not
      // asked for by a person, and `queuedBy` has to follow or the child's authority would be the
      // owner's rather than the authority the parent's grant was issued against.
      queuedBy: parent.queuedBy,
      queuedByAgentId: parent.queuedByAgentId,
      projectId: parent.projectId,
    });
    if (!created.ok) return created;
    const linked = await this.addLink({ fromCardId: parentCardId, toCardId: created.value.id, kind: 'parent' });
    if (!linked.ok) return { ok: false, code: linked.code, message: linked.message };
    return { ok: true, value: this.mustGetCard(created.value.id) };
  }

  /**
   * Split a card into several children at once — the tool that makes the parent/child construct
   * worth having (Task 15, spec §3.4): an agent decomposing the card it is working on into pieces
   * different capabilities can pick up in parallel, mid-run. Built on `createChildCard` (one call
   * per line), not on `addLink` directly, so it inherits that method's parentage and priority rules
   * unchanged.
   *
   * `agentId` (present only on the MCP/agent path — see the `BoardStub` doc comment) gates this to
   * "the card YOU are working on": without it, any `run`-scoped token could split any card in the
   * workspace, and the consequence is worse than an ordinary unauthorized write — creating a child
   * makes the target fail `blockedWhere`, so it drops out of `claim` and `list_work` and
   * `advanceCard` parks it, until that child resolves. One agent could freeze another team's card
   * indefinitely by giving it a child nobody will complete. Checked against `delegateAgentId`
   * (who currently holds the card's active run), not `ownerUserId` — the same identity `claim`
   * stamps onto the card and clears when the run ends.
   *
   * All-or-nothing on the two refusals:
   *  - more than `MAX_SPLIT_CHILDREN` lines ⇒ `TOO_MANY_CHILDREN`, before anything is created.
   *    Partially creating 20 of 21 would be worse than refusing outright, because the caller could
   *    not tell which of its lines had succeeded.
   *  - every line blank (before or after stripping) ⇒ `NOTHING_TO_SPLIT`, rather than silently
   *    succeeding with an empty `children` array.
   *
   * Deliberately NOT idempotent: calling this twice with the same titles creates two separate sets
   * of children. De-duplicating by title would silently drop a legitimately repeated sub-task — the
   * tool description tells the caller to call it once, and the UI confirms before a second call.
   *
   * The loop below creates children one at a time and returns early on the first failure (line
   * below: `if (!created.ok) return created;`), which WOULD be a partial-creation hole — k children
   * left behind, with the caller told nothing about them — except it is unreachable today:
   * `createChildCard`'s two failure modes beyond `NO_SUCH_CARD` (already checked above, before this
   * loop starts) are `addLink`'s `ALREADY_HAS_PARENT` and `LINK_WOULD_CYCLE`, and both require a
   * PRE-EXISTING edge that a brand-new leaf card — created fresh, one line above, with no links of
   * its own yet — cannot have. This is the sentence a refactor should have to falsify: if
   * `createChildCard` (or whatever this loop calls) ever gains a failure mode that a fresh child CAN
   * hit, this early-return stops being merely theoretical and the loop needs to collect-then-commit
   * or roll back what it already created.
   */
  async splitCard(
    cardId: string,
    titles: string[],
    actorUserId: string,
    agentId?: string | null,
  ): Promise<Result<{ children: CardView[] }>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    const card = this.getCard(cardId);
    if (!card) {
      return { ok: false, code: 'NO_SUCH_CARD', message: `card not found: ${cardId}` };
    }
    if (agentId !== undefined && agentId !== null && card.delegateAgentId !== agentId) {
      return { ok: false, code: 'NOT_RUN_OWNER', message: 'this card is not your active run' };
    }
    if (titles.length > MAX_SPLIT_CHILDREN) {
      return {
        ok: false,
        code: 'TOO_MANY_CHILDREN',
        message: `a card may be split into at most ${MAX_SPLIT_CHILDREN} children in one call, not ${titles.length}`,
      };
    }
    const cleanedTitles = titles.map(stripListLineSyntax).filter((t) => t.length > 0);
    if (cleanedTitles.length === 0) {
      return { ok: false, code: 'NOTHING_TO_SPLIT', message: 'every line was blank — nothing to split into' };
    }
    // A child's owner must be a HUMAN, because `owner_user_id` is what `notify()` files
    // gate/park/overdue notifications under and `getNotifications` reads back for the requesting
    // human — an id nobody can sign in as leaves that feed with no recipient. On the REST/human
    // path (no `agentId`), `actorUserId` already names the signed-in human and is used as before.
    // On the MCP/agent path (`agentId` present — the same signal the ownership check above uses),
    // `actorUserId` IS the calling agent's own id (`mcp/tools.ts` passes `auth.agentId` for both
    // parameters), so the PARENT's own owner is used instead: `card` above is that parent, already
    // fetched, and it is presumed to carry a human owner because nothing on any path can make
    // `ownerUserId` an agent id except this one now-closed hole.
    const childOwnerUserId = agentId ? card.ownerUserId : actorUserId;
    const children: CardView[] = [];
    for (const title of cleanedTitles) {
      const created = await this.createChildCard(cardId, { title, ownerUserId: childOwnerUserId });
      if (!created.ok) return created;
      children.push(created.value);
    }
    return { ok: true, value: { children } };
  }

  /**
   * Move `spec.due` onto the `due_at` column, once per board.
   *
   * Idempotent, and it *removes* the key from the spec rather than leaving a copy: two sources of
   * truth for one date is the condition this column exists to end. See the spec's §3.3 note — this
   * also takes the due date out of the agent prompt, which is intended, not a regression.
   */
  async backfillDueDates(): Promise<{ migrated: number }> {
    const rows = this.sql.exec(`SELECT id, spec_json FROM cards WHERE due_at IS NULL`).toArray();
    let migrated = 0;
    for (const row of rows) {
      let spec: Record<string, unknown>;
      try {
        spec = JSON.parse(row.spec_json as string) as Record<string, unknown>;
      } catch {
        continue; // an unparseable spec is not this migration's problem to fix
      }
      const due = spec.due;
      if (typeof due !== 'string' || due.trim() === '') continue;
      delete spec.due;
      this.sql.exec(
        `UPDATE cards SET due_at = ?, spec_json = ?, updated_at = ? WHERE id = ?`,
        due.trim(),
        JSON.stringify(spec),
        this.now(),
        row.id as string,
      );
      migrated += 1;
    }
    return { migrated };
  }

  /**
   * Move `spec.labels` onto `labels` (catalogue ids), once per board.
   *
   * Shares `sweepBoard`'s `dueBackfillDone` guard rather than a flag of its own — the reason this
   * exists is the same reason `backfillDueDates` does, so it runs at the same time, in the same
   * once-per-board pass. Names resolve through `resolveLabelNames` (`src/db/labels.ts`), which
   * reaches D1's tenant-scoped label catalogue rather than this DO's own SQLite storage — a name
   * not yet declared is created with `origin: 'inferred'`, exactly as a person typing it into
   * `CardDrawer.svelte` today would cause.
   *
   * Idempotent, and it *removes* the key from the spec rather than leaving a copy — two sources of
   * truth for one fact is the condition `card.labels` exists to end, same as `due_at`.
   */
  async backfillLabelNames(): Promise<{ migrated: number }> {
    const tenantId = this.getMeta('tenantId');
    if (!tenantId) return { migrated: 0 };
    const rows = this.sql.exec(`SELECT id, spec_json, labels FROM cards`).toArray();
    let migrated = 0;
    for (const row of rows) {
      let spec: Record<string, unknown>;
      try {
        spec = JSON.parse(row.spec_json as string) as Record<string, unknown>;
      } catch {
        continue; // an unparseable spec is not this migration's problem to fix
      }
      const raw = spec.labels;
      if (!Array.isArray(raw) || raw.length === 0) continue;
      const names = raw.filter((n): n is string => typeof n === 'string' && n.trim() !== '');
      delete spec.labels;
      if (names.length === 0) {
        // Nothing resolvable — an array of blanks or non-strings — but the stale key is cleared
        // regardless, same as a legacy `due` that fails its own shape check is still removed.
        this.sql.exec(`UPDATE cards SET spec_json = ?, updated_at = ? WHERE id = ?`, JSON.stringify(spec), this.now(), row.id as string);
        continue;
      }
      const resolvedIds = await resolveLabelNames(this.env.DB, tenantId, names, null);
      const existing = row.labels ? (JSON.parse(row.labels as string) as string[]) : [];
      const merged = [...new Set([...existing, ...resolvedIds])];
      this.sql.exec(
        `UPDATE cards SET labels = ?, spec_json = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(merged),
        JSON.stringify(spec),
        this.now(),
        row.id as string,
      );
      migrated += 1;
    }
    return { migrated };
  }

  /** Test-only: put a due date back in the spec and clear the column, to rehearse the migration. */
  async __testResetDueToSpec(cardId: string): Promise<void> {
    const row = this.sql.exec(`SELECT spec_json, due_at FROM cards WHERE id = ?`, cardId).one();
    const spec = JSON.parse(row.spec_json as string) as Record<string, unknown>;
    if (row.due_at) spec.due = row.due_at as string;
    this.sql.exec(`UPDATE cards SET due_at = NULL, spec_json = ? WHERE id = ?`, JSON.stringify(spec), cardId);
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
    /**
     * The AGENT doing the moving, when one is. A move re-queues the card, so the pair
     * `queued_by`/`queued_by_agent_id` must move together here exactly as on a create — otherwise a
     * card an agent re-queued reads as the operator's, or one a HUMAN re-queued keeps crediting the
     * agent that queued it first.
     */
    queuedByAgentId?: string | null,
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
    // Advancing IS a refusal, unlike claim's exclusion: this is an explicit act by a named caller,
    // not a selection from a set (see the header note on Task 13). Only an OPEN CHILD refuses it —
    // a parent whose sub-tasks are unfinished is not something anyone should be able to mark done.
    // An unresolved `blocks` edge deliberately does NOT refuse this: Principle 3 says a human owns
    // the card and is accountable, and can see the blocker badge, so a human move through a blocker
    // is allowed through (and recorded, below) rather than refused — the one place Linear's
    // advisory model is right.
    const openChildren = this.openChildCount(cardId);
    if (openChildren > 0) {
      return {
        ok: false,
        code: 'CARD_BLOCKED',
        // Direction-agnostic wording: this refusal applies to ANY move, forward or backward (e.g.
        // pulling a parent back to an earlier stage for rework), so it must not read as "you can't
        // finish yet" — it is simply a fact about the card, regardless of which way it is moving.
        message: `card has ${openChildren} open sub-task${openChildren === 1 ? '' : 's'}`,
      };
    }
    const unresolvedBlockers = this.unresolvedBlockerCount(cardId);
    const now = this.now();
    this.invalidateApprovalSubject(cardId, 'card.route_changed', actorUserId ?? null);
    // A manual move overrides any in-flight review: cancel pending gates and return the card to a
    // clean, claimable state. Without this, dragging a card off a human gate strands it in
    // input-required with an orphaned pending gate that no agent can claim and no human can resolve.
    // Runs whose wait this move ends — judged by a pending gate, or asking a pending question —
    // change reported state. Collected before the cancels below change what they read as.
    const waitingRuns = new Set<string>();
    for (const g of this.sql.exec(`SELECT * FROM gates WHERE card_id = ? AND status = 'pending'`, cardId).toArray()) {
      const judged = this.runJudgedByGate(g);
      if (judged) waitingRuns.add(judged);
    }
    for (const e of this.sql.exec(`SELECT DISTINCT run_id FROM elicitations WHERE card_id = ? AND status = 'pending'`, cardId).toArray()) {
      waitingRuns.add(e.run_id as string);
    }
    this.sql.exec(`UPDATE gates SET status = 'cancelled', resolved_at = ? WHERE card_id = ? AND status = 'pending'`, now, cardId);
    this.cancelElicitationsForCard(cardId);
    for (const r of waitingRuns) this.reportRun(r);
    // The person moving it IS the human attention the card was waiting for; carrying
    // the request across the move would ask for something already given.
    this.setNeedsHuman(cardId, null);
    // A move by a person re-queues the card, so the mover becomes the queuer —
    // they are the one dispatching it now, which is not necessarily the person
    // who created it. Without an actor (an internal move) the previous queuer
    // stands: COALESCE leaves it alone rather than blanking it.
    /**
     * Moving a card to a last stage nobody can act on finishes it — which is what a person means
     * when they drag a card to `done`. Same rule as the agent path (`completesOnArrival`), because
     * the question it answers is about the STAGE, not about who put the card there.
     *
     * After the gate-cancel and blocker checks above, so a move that would have been refused still
     * is: an unresolved blocker or an open child stops this exactly as before.
     */
    if (this.completesOnArrival(target)) {
      this.resolveCard(cardId, this.getCardHandoffJson(cardId), target.key);
      const resolved = this.mustGetCard(cardId);
      this.emit('card.moved', { cardId, from: card.currentStageKey, to: target.key });
      await this.scheduleReclaim();
      return { ok: true, value: resolved };
    }
    this.sql.exec(
      `UPDATE cards SET current_stage_key = ?, state = 'submitted', delegate_agent_id = NULL, current_run_id = NULL,
              failure_count = 0, auto_returns = 0, updated_at = ?, queued_by = COALESCE(?, queued_by),
              -- Moves WITH the pair, never apart. A human re-queueing an agent-queued card
              -- becomes its queuer, and leaving the agent id standing would make the card read
              -- "queued by <some agent>" about a dispatch the operator personally authorised.
              -- An internal move (no actor) dispatches nothing new, so both values stand. An AGENT
              -- mover sets it to ITSELF, for the same reason it sets queued_by: whoever re-queued
              -- the card is who the record has to name.
              queued_by_agent_id = CASE WHEN ? IS NULL THEN queued_by_agent_id ELSE ? END,
              queued_grant = CASE WHEN ? IS NULL THEN queued_grant ELSE ? END WHERE id = ?`,
      target.key,
      now,
      actorUserId ?? null,
      actorUserId ?? null,
      queuedByAgentId ?? null,
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
    // The override is made VISIBLE, not silently allowed (Principle 3: a human is accountable for
    // moving a card past a blocker they can see on the badge, and the record is how that
    // accountability stays legible after the fact).
    if (unresolvedBlockers > 0) {
      this.notify(
        'moved-while-blocked',
        cardId,
        `moved to "${target.name}" past ${unresolvedBlockers} unresolved blocker${unresolvedBlockers === 1 ? '' : 's'}${actorUserId ? ` by ${actorUserId}` : ''}`,
      );
    }
    await this.scheduleReclaim();
    return { ok: true, value: updated };
  }

  /**
   * Resume a card that is waiting on a person: the human half of a block.
   *
   * Returns the card to its current stage — or a named EARLIER one — as `submitted`, with the
   * person's comment kept twice: on the card's thread, where people read it, and as
   * `handoff.feedback`, which the next claim and the run context carry to the agent (the path a
   * reviewer's request-changes uses). `needsHuman` is cleared, and the stage starts over: the
   * breaker count goes to zero and the automatic completion rework is owed again.
   *
   * Refused where a more specific answer exists, rather than letting resume paper over it:
   *  - an open question (`QUESTION_PENDING`) is answered through its own form, so the agent gets
   *    the answer it asked for instead of a card that silently restarted under it;
   *  - a pending review (`GATE_PENDING`) is decided — request-changes IS the resume for a review,
   *    and resuming around it would leave a gate deciding nothing;
   *  - a later stage (`INVALID_RESUME`) is a move, not a resume.
   *
   * Resuming re-queues the card, so the person resuming becomes its queuer, exactly as a move does.
   */
  async resumeCard(input: {
    cardId: string;
    comment: string;
    toStageKey?: string;
    actor: { id: string; name: string | null };
    queuedGrant?: string[] | null;
  }): Promise<Result<{ card: CardView; comment: CommentView }>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    const card = this.getCard(input.cardId);
    if (!card) return { ok: false, code: 'CARD_NOT_FOUND', message: `card not found: ${input.cardId}` };
    if (typeof input.comment !== 'string' || input.comment.trim() === '') {
      return { ok: false, code: 'INVALID_COMMENT', message: 'resuming a card needs a comment saying what changed' };
    }
    const bytes = new TextEncoder().encode(input.comment).length;
    if (bytes > COMMENT_MAX_BYTES) {
      return { ok: false, code: 'INVALID_COMMENT', message: `a comment is at most ${COMMENT_MAX_BYTES} bytes; this one is ${bytes}` };
    }
    if (card.state !== 'input-required') {
      return { ok: false, code: 'CARD_NOT_WAITING', message: `a card in "${card.state}" is not waiting on anybody` };
    }
    const boardId = this.getMeta('boardId');
    const question = this.sql
      .exec(`SELECT id FROM elicitations WHERE card_id = ? AND status = 'pending' LIMIT 1`, card.id)
      .toArray()[0];
    if (question) {
      return {
        ok: false,
        code: 'QUESTION_PENDING',
        message: `this card's agent asked a question — answer it instead (POST /v1/boards/${boardId}/elicitations/${question.id as string}/answer, or the card in the web app)`,
      };
    }
    if (this.sql.exec(`SELECT 1 FROM gates WHERE card_id = ? AND status = 'pending' LIMIT 1`, card.id).toArray().length > 0) {
      return {
        ok: false,
        code: 'GATE_PENDING',
        message: `this card is waiting on a review — decide it instead: supi approve, or supi request-changes ${boardId} <gateId> --comment "…" to send it back`,
      };
    }
    const openChildren = this.openChildCount(card.id);
    if (openChildren > 0) {
      return { ok: false, code: 'CARD_BLOCKED', message: `card has ${openChildren} open sub-task${openChildren === 1 ? '' : 's'}` };
    }
    const stages = this.stages();
    const currentIdx = stages.findIndex((s) => s.key === card.currentStageKey);
    const targetKey = input.toStageKey ?? card.currentStageKey;
    const targetIdx = stages.findIndex((s) => s.key === targetKey);
    if (targetIdx === -1) return { ok: false, code: 'UNKNOWN_STAGE', message: `unknown stage: ${targetKey}` };
    if (currentIdx !== -1 && targetIdx > currentIdx) {
      return { ok: false, code: 'INVALID_RESUME', message: `"${targetKey}" is after "${card.currentStageKey}" — resume returns a card to its stage or an earlier one; move it to go forward` };
    }

    const now = this.now();
    const prior = this.parseHandoff(this.getCardHandoffJson(card.id));
    const merged =
      prior && typeof prior === 'object' && !Array.isArray(prior) ? { ...prior, feedback: input.comment } : { feedback: input.comment };
    const grant = input.queuedGrant === undefined || input.queuedGrant === null ? null : JSON.stringify(input.queuedGrant);
    this.sql.exec(
      `UPDATE cards SET current_stage_key = ?, state = 'submitted', delegate_agent_id = NULL, current_run_id = NULL,
              failure_count = 0, needs_human_json = NULL, completion_rework_json = NULL, pending_advance_json = NULL,
              auto_returns = 0, handoff_json = ?, updated_at = ?, queued_by = ?, queued_by_agent_id = NULL,
              queued_grant = CASE WHEN ? IS NULL THEN queued_grant ELSE ? END
        WHERE id = ?`,
      targetKey,
      JSON.stringify(merged),
      now,
      input.actor.id,
      grant,
      grant,
      card.id,
    );
    const comment = await this.addComment({ cardId: card.id, author: { kind: 'human', ...input.actor }, body: input.comment });
    if (!comment.ok) return comment;
    this.emit('card.resumed', { cardId: card.id, from: card.currentStageKey, to: targetKey, by: input.actor.id, commentId: comment.value.id });
    this.notifyWorkAvailable(card.id);
    await this.scheduleReclaim();
    return { ok: true, value: { card: this.mustGetCard(card.id), comment: comment.value } };
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
  /**
   * One card, read.
   *
   * The projection is `getCard`'s, which is `allCards`', which is the snapshot's — deliberately,
   * so a client reading one card and a client reading the board never disagree about it. Nothing
   * new is computed here; this exists because the REST prefix served `PATCH` and `DELETE` and had
   * no way to read (#90), while its own subroutes — `/attempts`, `/activities`, `/estimate` — all
   * did.
   */
  async getCardView(cardId: string): Promise<Result<CardView>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    const card = this.getCard(cardId);
    if (!card) return { ok: false, code: 'CARD_NOT_FOUND', message: `card not found: ${cardId}` };
    return { ok: true, value: card };
  }

  async updateCard(
    cardId: string,
    patch: {
      title?: string;
      spec?: JsonValue;
      priority?: number;
      ownerUserId?: string;
      labels?: string[];
      dueAt?: string | null;
      archivedAt?: string | null;
      projectId?: string | null;
      milestoneId?: string | null;
      /**
       * A precondition, not a field: the card's `updatedAt` as the caller last read it. When
       * present and the card has moved on since, nothing is written and `CARD_CHANGED` comes back.
       * A read-modify-write (`supi edit-card --merge-spec`) sends it so it cannot overwrite an edit
       * it never saw. Absent, the patch applies as it always has.
       */
      expectedUpdatedAt?: string | null;
    },
  ): Promise<Result<CardView>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    const existing = this.getCard(cardId);
    if (!existing) return { ok: false, code: 'CARD_NOT_FOUND', message: `card not found: ${cardId}` };
    if (patch.expectedUpdatedAt !== undefined && patch.expectedUpdatedAt !== existing.updatedAt) {
      return {
        ok: false,
        code: 'CARD_CHANGED',
        message: `card ${cardId} changed since it was read (updatedAt is now ${existing.updatedAt ?? 'null'})`,
      };
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      vals.push(patch.title);
    }
    const normalizedSpec =
      patch.spec === undefined
        ? undefined
        : this.getMeta('dueBackfillDone')
          ? stripStaleSpecKeys(patch.spec)
          : patch.spec;
    if (patch.spec !== undefined) {
      sets.push('spec_json = ?');
      vals.push(JSON.stringify(normalizedSpec));
    }
    if (patch.priority !== undefined) {
      sets.push('priority = ?');
      vals.push(patch.priority);
    }
    if (patch.ownerUserId !== undefined) {
      sets.push('owner_user_id = ?');
      vals.push(patch.ownerUserId);
    }
    if (patch.labels !== undefined) {
      sets.push('labels = ?');
      vals.push(JSON.stringify([...new Set(patch.labels)]));
    }
    if (patch.dueAt !== undefined) {
      sets.push('due_at = ?');
      // Validation lives at the route (`PATCH /cards/:id` in index.ts) — this DO is reachable from
      // more than one caller, so a non-string here is stored as-is rather than crashing `.trim()`.
      const normalizedDueAt = patch.dueAt === null || typeof patch.dueAt !== 'string' ? patch.dueAt : patch.dueAt.trim();
      vals.push(normalizedDueAt);
      // A changed date is a new chance to be told about it — but `dueAt` is sent on EVERY save
      // (CardDrawer.svelte), not only when the date itself changed, so this must compare against
      // the value actually stored rather than fire on `patch.dueAt !== undefined` alone. Otherwise
      // editing a card's title re-arms the overdue nag and the next sweep spams the owner again.
      if (normalizedDueAt !== existing.dueAt) {
        sets.push('overdue_notified_at = NULL'); // no placeholder, so no `vals` entry
      }
    }
    if (patch.archivedAt !== undefined) {
      sets.push('archived_at = ?');
      vals.push(patch.archivedAt);
    }
    if (patch.projectId !== undefined) {
      sets.push('project_id = ?');
      vals.push(patch.projectId);
    }
    if (patch.milestoneId !== undefined) {
      sets.push('milestone_id = ?');
      vals.push(patch.milestoneId);
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      // Strictly after the stored value, never equal to it: `expectedUpdatedAt` compares
      // timestamps, and Workers freezes the clock inside a request, so two edits in one window
      // would otherwise carry the same `updatedAt` and a stale precondition would pass.
      const nowMs = Date.parse(this.now());
      const prevMs = existing.updatedAt ? Date.parse(existing.updatedAt) : Number.NaN;
      vals.push(new Date(Number.isNaN(prevMs) ? nowMs : Math.max(nowMs, prevMs + 1)).toISOString());
      this.ctx.storage.transactionSync(() => {
        this.invalidateApprovalSubject(cardId, patch.spec !== undefined ? 'card.spec_changed' : 'card.changed', null);
        this.sql.exec(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`, ...vals, cardId);
      });
    }
    const card = this.mustGetCard(cardId);
    this.emit('card.updated', { card });
    return { ok: true, value: card };
  }

  /** Delete a card and everything scoped to it (references, runs, activities, gates, usage, notifications, links). */
  async deleteCard(cardId: string): Promise<Result<{ ok: true }>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    if (!this.getCard(cardId)) return { ok: false, code: 'CARD_NOT_FOUND', message: `card not found: ${cardId}` };
    // Captured before the edge is deleted below — a deleted card may be the last open child of a
    // parent parked on a deferred advance (Task 14 step 3), which `resumeParentAdvanceIfFree` needs
    // to know to check.
    const parentId = this.parentIdOf(cardId);
    for (const t of ['usage_records', 'activities', 'runs', 'gates', 'elicitations', 'card_references', 'notifications', 'card_comments']) {
      this.sql.exec(`DELETE FROM ${t} WHERE card_id = ?`, cardId);
    }
    // Both directions. A deleted card's edges must go with it: a lingering `blocks` row points at a
    // card that no longer exists, and the drawer would render a blocker nobody can open or resolve.
    // `card_links` is keyed on two columns, so it cannot join the single-column loop above.
    this.sql.exec(`DELETE FROM card_links WHERE from_card_id = ? OR to_card_id = ?`, cardId, cardId);
    this.sql.exec(`DELETE FROM cards WHERE id = ?`, cardId);
    this.emit('card.deleted', { cardId });
    if (parentId) this.resumeParentAdvanceIfFree(parentId);
    await this.scheduleReclaim();
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
      const invalid = stageFieldError(s);
      if (invalid) return { ok: false, code: 'INVALID_STAGES', message: invalid };
      // Also here, not only in the PATCH: a check the whole-pipeline write skips is a check with
      // a documented way around it.
      if (s.completion !== undefined) {
        const bad = completionShapeError(s.completion);
        if (bad) return { ok: false, code: 'INVALID_STAGES', message: `stage "${s.key}": ${bad}` };
      }
    }
    const keys = stages.map((s) => s.key);
    const duplicate = keys.find((k, i) => keys.indexOf(k) !== i);
    if (duplicate) {
      // Two stages sharing a key is not a pipeline: `stages().find(...)` would resolve every card
      // in both to whichever came first, and the other would be unreachable.
      return { ok: false, code: 'INVALID_STAGES', message: `two stages share the key "${duplicate}"` };
    }
    // Across the NEW pipeline, so removing or reordering the stage another one returns to is
    // refused here rather than leaving a judge whose failing verdict has nowhere to go.
    for (const s of stages) {
      const bad = returnStageError(s, stages);
      if (bad) return { ok: false, code: 'INVALID_STAGES', message: bad };
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

    // A capability owner is normalised with the same function that spells an agent's
    // capabilities, because matching is exact string equality — a stage whose owner is typed
    // "Code Review" must carry `code-review`, or no agent can ever claim it and nothing says why.
    //
    // WHAT is matched is `stageCapabilitiesMet` (@superpipeline/contract): a stage's `requires`
    // when it has one — `all` every member, `any` at least one — and `owner` only when it does
    // not. This comment used to say routing was `agent.capabilities.includes(stage.owner)`, full
    // stop, which stopped being true when requirements shipped on 2026-09-03 and was still here
    // three weeks later. It sits where somebody asking "how does routing work" reads, so it was
    // believed over the code, and issue #88 was filed against behaviour that already worked.
    // `test/claim-honours-requires.test.ts` pins the real answer at the claim boundary.
    const ordered = [...stages]
      .map(normalizeStageRouting)
      .sort((a, b) => a.order - b.order);
    this.setMeta('stages', JSON.stringify(ordered));
    this.emit('board.stages_changed', { stages: ordered });
    return { ok: true, value: { stages: ordered } };
  }

  /**
   * Change one stage without rewriting the pipeline.
   *
   * `setStages` replaces every stage, so adjusting one field meant reading them all, mutating
   * one, and writing them all back — which discards any concurrent edit to a stage the caller
   * never touched. This writes the one stage named and leaves its neighbours exactly as found.
   *
   * Validation is the same function the whole-pipeline write uses, so a rule accepted here is a
   * rule that would survive a replace.
   */
  async updateStage(stageKey: string, patch: StagePatch): Promise<Result<{ stage: StageDef }>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    const stages = this.stages();
    const index = stages.findIndex((s) => s.key === stageKey);
    if (index === -1) {
      // Named rather than created. A patch that invents a stage puts a lane on the board that no
      // card can reach and nothing asked for, and a typo is the likeliest way to get here.
      return { ok: false, code: 'UNKNOWN_STAGE', message: `unknown stage: ${stageKey}` };
    }

    const next: StageDef = { ...stages[index]! };
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || patch.name.trim() === '') {
        return { ok: false, code: 'INVALID_STAGES', message: `stage "${stageKey}" needs a name` };
      }
      next.name = patch.name;
    }
    if (patch.ownerKind !== undefined) next.ownerKind = patch.ownerKind;
    if (patch.owner !== undefined) next.owner = patch.owner;
    if (patch.gate !== undefined) next.gate = patch.gate;
    // `null` is the removal. `undefined` cannot be, because it is what an absent field already
    // means — a caller sending JSON has no other way to say "take this off".
    if (patch.requires !== undefined) {
      if (patch.requires === null) delete next.requires;
      else next.requires = patch.requires;
    }
    if (patch.wipLimit !== undefined) {
      if (patch.wipLimit === null) delete next.wipLimit;
      else next.wipLimit = patch.wipLimit;
    }
    if (patch.instructions !== undefined) {
      if (patch.instructions === null) delete next.instructions;
      else next.instructions = patch.instructions;
    }
    if (patch.completion !== undefined) {
      if (patch.completion === null) delete next.completion;
      else {
        const invalid = completionShapeError(patch.completion);
        if (invalid) return { ok: false, code: 'INVALID_STAGES', message: `stage "${stageKey}": ${invalid}` };
        next.completion = patch.completion;
      }
    }

    if (patch.returnStage !== undefined) {
      if (patch.returnStage === null) delete next.returnStage;
      else next.returnStage = patch.returnStage;
    }

    const invalid = stageFieldError(next);
    if (invalid) return { ok: false, code: 'INVALID_STAGES', message: invalid };
    const badReturn = returnStageError(next, stages);
    if (badReturn) return { ok: false, code: 'INVALID_STAGES', message: badReturn };

    const normalized = normalizeStageRouting(next);
    const ordered = stages.map((s, i) => (i === index ? normalized : s));
    this.setMeta('stages', JSON.stringify(ordered));
    this.emit('board.stages_changed', { stages: ordered });
    return { ok: true, value: { stage: normalized } };
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
      'run_reports',
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
        (id, card_id, url, title, subtitle, provider, source_type, external_id, metadata_json, sync_state, last_synced_at, added_by, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.runId ?? null,
      now,
    );
    const ref = this.mustGetReference(id);
    this.emit('reference.added', { reference: ref });
    return { ok: true, value: ref };
  }

  /**
   * Declare an edge between two cards on this board (spec §3.4). `blocks` and `parent` both order
   * work and so can deadlock; `relates` is decoration and is exempt from both checks below.
   *
   * Idempotent on the primary key: re-declaring the exact same (from, to, kind) is a no-op, not an
   * error — the same reasoning as `addImplication` (`db/implications.ts`).
   *
   * Refusals are one distinct code per reason, not a generic one, because a caller needs to know
   * what to do next: `NO_SUCH_CARD` (either end is missing), `ALREADY_HAS_PARENT` (a card may have
   * at most one `parent` edge pointing at it — enforced again by `card_links_one_parent` for any
   * caller that reaches the table directly), `LINK_WOULD_CYCLE` (this edge would close a loop among
   * the ordering kinds — see `links.ts#wouldCycle`).
   */
  async addLink(input: LinkInput): Promise<Result<LinkView>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    if (!this.getCardRow(input.fromCardId)) {
      return { ok: false, code: 'NO_SUCH_CARD', message: `card not found: ${input.fromCardId}` };
    }
    if (!this.getCardRow(input.toCardId)) {
      return { ok: false, code: 'NO_SUCH_CARD', message: `card not found: ${input.toCardId}` };
    }
    if (input.kind === 'parent') {
      const existingParent = this.sql
        .exec(`SELECT from_card_id FROM card_links WHERE to_card_id = ? AND kind = 'parent'`, input.toCardId)
        .toArray()[0];
      if (existingParent && (existingParent.from_card_id as string) !== input.fromCardId) {
        return {
          ok: false,
          code: 'ALREADY_HAS_PARENT',
          message: `card ${input.toCardId} already has a parent (${existingParent.from_card_id as string})`,
        };
      }
    }
    const candidate: LinkRow = { fromCardId: input.fromCardId, toCardId: input.toCardId, kind: input.kind };
    if (wouldCycle(this.allLinks(), candidate)) {
      return {
        ok: false,
        code: 'LINK_WOULD_CYCLE',
        message: `linking ${input.fromCardId} -> ${input.toCardId} (${input.kind}) would close a cycle`,
      };
    }
    const now = this.now();
    this.sql.exec(
      `INSERT INTO card_links (from_card_id, to_card_id, kind, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (from_card_id, to_card_id, kind) DO NOTHING`,
      input.fromCardId,
      input.toCardId,
      input.kind,
      now,
      input.createdBy ?? null,
    );
    const link = this.mustGetLink(input.fromCardId, input.toCardId, input.kind);
    this.emit('link.added', { link });
    return { ok: true, value: link };
  }

  /** Remove an edge. Deleting a link that does not exist is not an error — the end state is what was asked for. */
  async removeLink(fromCardId: string, toCardId: string, kind: LinkKind): Promise<Result<{ ok: true }>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    this.sql.exec(`DELETE FROM card_links WHERE from_card_id = ? AND to_card_id = ? AND kind = ?`, fromCardId, toCardId, kind);
    this.emit('link.removed', { fromCardId, toCardId, kind });
    // Un-parenting a card is the other way (besides completion) it can stop counting as an open
    // child — see `resumeParentAdvanceIfFree`'s note. `fromCardId` IS the parent for a `parent` edge.
    if (kind === 'parent') this.resumeParentAdvanceIfFree(fromCardId);
    await this.scheduleReclaim();
    return { ok: true, value: { ok: true } };
  }

  /** Every edge touching `cardId`, either as source or target — what the drawer renders. */
  async listLinks(cardId: string): Promise<LinkView[]> {
    return this.sql
      .exec(
        `SELECT * FROM card_links WHERE from_card_id = ? OR to_card_id = ? ORDER BY created_at ASC`,
        cardId,
        cardId,
      )
      .toArray()
      .map((r) => this.rowToLink(r));
  }

  /** Store/rotate this board's GitHub webhook secret (docs/06 §3, §6). */
  async setForgeSecret(secret: string): Promise<Result<{ configured: true }>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    // Its own secret, never the GitHub one. A board may legitimately receive from both — a repo
    // that is forge-primary and mirrored — and one shared secret would mean revoking either
    // side's access revokes the other's.
    this.setMeta('forgeWebhookSecret', secret);
    return { ok: true, value: { configured: true } };
  }

  /**
   * An inbound Forgejo webhook.
   *
   * Deliberately parallel to `handleGithubWebhook` and deliberately not shared with it. The
   * dedupe table, the fail-closed delivery check and the reference update are identical; the
   * signature spelling and the event vocabulary are not, and those are exactly the parts that
   * fail silently when assumed (Forgejo sends `synchronized`, GitHub `synchronize`).
   *
   * Deliveries share one table with GitHub's on purpose: a delivery id is a delivery id, and a
   * board receiving from a forge-primary repository AND its GitHub mirror should not process the
   * same underlying change twice because the two arrived by different doors.
   */
  async handleForgeWebhook(input: {
    rawBody: string;
    signature: string | null;
    deliveryId: string | null;
    event: string;
  }): Promise<Result<{ deduped: boolean; matched: number; modeled: boolean }>> {
    if (!this.getMeta('boardId')) {
      return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    }
    const secret = this.getMeta('forgeWebhookSecret');
    if (!secret) {
      return { ok: false, code: 'NOT_CONFIGURED', message: 'no forge webhook secret configured for this board' };
    }
    if (!(await verifyForgeSignature(secret, input.rawBody, input.signature))) {
      return { ok: false, code: 'INVALID_SIGNATURE', message: 'invalid X-Forgejo-Signature' };
    }
    // Fail closed, for the reason the GitHub path gives: a missing delivery id would silently
    // disable replay protection. Recorded only after the signature verifies, so an unverified
    // request can never poison the table.
    if (!input.deliveryId) {
      return { ok: false, code: 'INVALID_DELIVERY', message: 'missing X-Forgejo-Delivery' };
    }
    const seen = this.sql.exec(`SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?`, input.deliveryId).toArray()[0];
    if (seen) return { ok: true, value: { deduped: true, matched: 0, modeled: false } };
    this.sql.exec(`INSERT INTO webhook_deliveries (delivery_id, received_at) VALUES (?, ?)`, input.deliveryId, this.now());

    let payload: unknown;
    try {
      const raw = input.rawBody;
      const jsonText = raw.startsWith('payload=') ? (new URLSearchParams(raw).get('payload') ?? raw) : raw;
      payload = JSON.parse(jsonText);
    } catch {
      return { ok: true, value: { deduped: false, matched: 0, modeled: false } };
    }

    const mapped = mapForgeEvent(input.event, payload);
    if (!mapped) return { ok: true, value: { deduped: false, matched: 0, modeled: false } };

    const now = this.now();
    // Matched by provider AS WELL AS external_id. `externalId` is `owner/repo#n` for GitHub and
    // for forge alike, and a push mirror mirrors git refs — not pull requests — so a forge PR #7
    // and a GitHub PR #7 on a mirrored repository are DIFFERENT objects sharing an id. Without the
    // provider, a delivery from one writes its state onto the other's reference: a wrong
    // enrichment, which is harder to notice than a missing one.
    const rows = this.sql
      .exec(`SELECT * FROM card_references WHERE external_id = ? AND provider = 'forge'`, mapped.externalId)
      .toArray();
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
    return { ok: true, value: { deduped: false, matched: rows.length, modeled: true } };
  }

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
        // Provider-qualified for the same reason the matchers are: a forge issue #12 must not
        // suppress the card a GitHub issue #12 should have created.
        const exists = this.sql
          .exec(`SELECT 1 FROM card_references WHERE external_id = ? AND provider = 'github' LIMIT 1`, externalId)
          .toArray()[0];
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
    // Matched by provider AS WELL AS external_id. `externalId` is `owner/repo#n` for GitHub and
    // for forge alike, and a push mirror mirrors git refs — not pull requests — so a forge PR #7
    // and a GitHub PR #7 on a mirrored repository are DIFFERENT objects sharing an id. Without the
    // provider, a delivery from one writes its state onto the other's reference: a wrong
    // enrichment, which is harder to notice than a missing one.
    const rows = this.sql
      .exec(`SELECT * FROM card_references WHERE external_id = ? AND provider = 'github'`, mapped.externalId)
      .toArray();
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
   * This board's slice of one project's rollup (Task 19) — see the `BoardStub` interface comment
   * for why nothing on the claim or advance path may ever call it.
   *
   * Returns a `Result`, like every other externally-callable method here, rather than throwing a
   * bare exception across the RPC boundary for the uninitialized case: workerd logs a thrown RPC
   * exception as its own top-level "uncaught exception" regardless of whether the caller catches
   * the rejection, which is harmless in production but makes a deliberately-exercised failure path
   * indistinguishable from a real crash in a test run. `computeRollup` (`db/projects.ts`) still
   * wraps its call in try/catch for genuinely unexpected throws; the `Result` is what keeps the
   * one failure this is actually built to survive — a board whose DO was never initialized — from
   * ever being a real exception in the first place.
   *
   * `done` matches `RESOLVED_SQL`, the same "resolved, not merely terminal" rule
   * `unresolvedBlockerExists`/`openChildCount` already enforce elsewhere in this file: a `failed`
   * card is terminal but not done, so counting it as done would report a project complete while
   * part of its work failed.
   *
   * `overdue` mirrors `sweepBoard`'s own overdue predicate (due, not archived, not terminal) —
   * the same fact, read here instead of notified.
   */
  async projectSummary(projectId: string): Promise<Result<{ total: number; done: number; overdue: number; costUsd: number }>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    const today = this.now().slice(0, 10);
    const counts = this.sql
      .exec(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN state IN ${BoardDO.RESOLVED_SQL} THEN 1 ELSE 0 END), 0) AS done,
           COALESCE(SUM(CASE WHEN due_at IS NOT NULL AND due_at < ? AND archived_at IS NULL
                             AND state NOT IN ('completed', 'canceled', 'rejected', 'failed')
                        THEN 1 ELSE 0 END), 0) AS overdue
         FROM cards WHERE project_id = ?`,
        today,
        projectId,
      )
      .one();
    const cost = this.sql
      .exec(
        `SELECT COALESCE(SUM(u.cost_usd), 0) AS c FROM usage_records u
           JOIN cards c ON c.id = u.card_id WHERE c.project_id = ?`,
        projectId,
      )
      .one();
    return {
      ok: true,
      value: {
        total: Number(counts.total),
        done: Number(counts.done),
        overdue: Number(counts.overdue),
        costUsd: Number(cost.c),
      },
    };
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
    const unknown = (input.events ?? []).filter((e) => !SUBSCRIBABLE_EVENTS.has(e));
    if (unknown.length > 0) return { ok: false, code: 'UNKNOWN_EVENT', message: `cannot subscribe to: ${unknown.join(', ')}` };
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

  /** The superwitness outbox, soonest due first (tests, and the backfill route's counts). */
  async getRunReportOutbox(): Promise<RunReportOutboxRow[]> {
    return this.sql
      .exec(`SELECT * FROM run_reports ORDER BY next_attempt_at ASC, run_id ASC`)
      .toArray()
      .map((r) => ({
        runId: r.run_id as string,
        gen: Number(r.gen),
        status: r.status as 'pending' | 'dead',
        attempts: Number(r.attempts),
        nextAttemptAt: Number(r.next_attempt_at),
        lastError: (r.last_error as string | null) ?? null,
        reportedAt: r.reported_at as string,
        draft: JSON.parse(r.report_json as string) as RunReportDraft,
      }));
  }

  /**
   * Send due superwitness run reports (superwitness app spec §3.5). Called by the alarm, and by the
   * Worker cron as a backstop. `fetcher`/`nowMs` are injectable for tests, like
   * `dispatchPushDeliveries`'s sender. Never throws for a delivery failure — those are recorded on
   * the rows.
   */
  async drainRunReports(opts: { fetcher?: ReporterFetch; nowMs?: number } = {}): Promise<RunReportDrainResult> {
    if (this.reportDrain) return this.reportDrain;
    const run = this.drainRunReportsOnce(opts.fetcher ?? defaultReporterFetch, opts.nowMs ?? this.nowMs());
    this.reportDrain = run;
    try {
      return await run;
    } finally {
      this.reportDrain = null;
    }
  }

  /**
   * Enqueue one report per run on this board (superwitness app spec §3.5 backfill; ruling R18).
   *
   * Safe to re-run: each run is reported at its OWN stored update time and nothing here bumps it,
   * so a report superwitness already holds arrives with an equal `reported_at` and is a no-op
   * there. Parked rows go back to pending, which makes this the repair tool as well.
   */
  async enqueueAllRunReports(): Promise<Result<{ enqueued: number; pending: number; dead: number }>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    let enqueued = 0;
    if (reportingEnabled(this.env)) {
      for (const run of this.sql.exec(`SELECT * FROM runs ORDER BY started_at ASC`).toArray()) {
        const reportedAt = (run.updated_at as string | null) ?? (run.ended_at as string | null) ?? (run.started_at as string);
        this.enqueueRunReport(run, reportedAt);
        enqueued += 1;
      }
      await this.scheduleReclaim();
    }
    const counts = this.sql
      .exec(
        `SELECT COALESCE(SUM(status = 'pending'), 0) AS pending, COALESCE(SUM(status = 'dead'), 0) AS dead FROM run_reports`,
      )
      .one();
    return { ok: true, value: { enqueued, pending: Number(counts.pending), dead: Number(counts.dead) } };
  }

  /**
   * Drain pending push deliveries: sign each with its config token and send (docs/05 §4). The sender
   * is injectable (tests pass a stub); production durability — Queue + Workflow with exponential
   * backoff — wraps this. A single drain marks each delivery sent/failed.
   */
  async dispatchPushDeliveries(sender: PushSender = defaultPushSender, opts?: { timeoutMs?: number }): Promise<{ sent: number; failed: number }> {
    // Retry pending + previously-failed rows under the attempt cap; exhausted ones are dead-lettered.
    // Fresh deliveries go first (attempts ASC), and no one config takes more than
    // MAX_PUSH_PER_CONFIG_PER_DRAIN of a drain, so a down endpoint's retries cannot starve another
    // config's pushes on the same board.
    const perConfig = new Map<string, number>();
    const rows = this.sql
      .exec(
        `SELECT d.id, d.config_id, d.url, d.body, d.attempts, c.token FROM push_deliveries d JOIN push_configs c ON d.config_id = c.id
         WHERE d.status IN ('pending', 'failed') AND d.attempts < ? ORDER BY d.attempts ASC, d.id ASC LIMIT 500`,
        MAX_PUSH_ATTEMPTS,
      )
      .toArray()
      .filter((r) => {
        const n = perConfig.get(r.config_id as string) ?? 0;
        if (n >= MAX_PUSH_PER_CONFIG_PER_DRAIN) return false;        
        perConfig.set(r.config_id as string, n + 1);
        return true;
      })
      .slice(0, 50);
    let sent = 0;
    let failed = 0;
    for (const r of rows) {
      const outcome = await signAndSend({ id: Number(r.id), url: r.url as string, body: r.body as string, token: r.token as string }, sender, opts?.timeoutMs);
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

  // ----- RPC: schedules (spec §3.7) -----

  /**
   * Define a recurring card.
   *
   * `createdBy` is required, not optional: a schedule mints cards on its own, with no human in the
   * loop at fire time, and Principle 3 says every card has a human owner. A schedule with no
   * recorded creator cannot satisfy that, so it is refused here rather than accepted and quietly
   * disabled later.
   *
   * The rule is validated through `parseRule` and its own error message is returned verbatim — a
   * rule is typed by a human, and the parser's message is the only one worth showing them. The
   * timezone is validated by construction: an `Intl.DateTimeFormat` either accepts it or throws.
   * Never compare it against a list, or against `resolvedOptions().timeZone` — ICU canonicalises
   * `Asia/Kolkata` to `Asia/Calcutta`, so a string comparison rejects zones that work perfectly
   * (Task 1's spike). The operator's own spelling is what gets stored.
   *
   * `stageKey`, `overlap` and `createdBy` are all refused here too, on the same argument as the
   * rule and the timezone: a human is standing right here, reading the response, which is the
   * only moment any of this is cheap to fix. A `stageKey` naming no stage on this board would
   * otherwise surface months later as cards silently landing in the default lane; an `overlap`
   * outside `'skip' | 'allow'` would otherwise be read by `fireDueSchedules`'s `=== 'skip'` check
   * as *allow* — the permissive direction, and the wrong one to fail open into.
   */
  async createSchedule(input: {
    title: string;
    rule: string;
    timezone: string;
    overlap: 'skip' | 'allow';
    createdBy: string;
    spec?: JsonValue;
    priority?: number;
    labels?: string[];
    stageKey?: string | null;
    enabled?: boolean;
    /**
     * What the creator was permitted to dispatch, captured at the moment the schedule was
     * declared — the only moment there is a caller present to ask. `fireDueSchedules` passes this
     * straight to `createCardFromTrigger`, whose own `?? this.triggerGrant()` fallback remains for
     * schedules created before this field existed. See the `schedules.queued_grant` column note.
     */
    queuedGrant?: string[] | null;
  }): Promise<Result<ScheduleView>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };

    const parsed = parseRule(input.rule);
    if (!parsed.ok) return { ok: false, code: 'INVALID_RULE', message: parsed.error };

    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: input.timezone });
    } catch {
      return { ok: false, code: 'INVALID_TIMEZONE', message: `"${input.timezone}" is not a time zone this runtime knows` };
    }

    if (input.stageKey && !this.stages().some((s) => s.key === input.stageKey)) {
      return { ok: false, code: 'UNKNOWN_STAGE', message: `unknown stage: ${input.stageKey}` };
    }

    if (input.overlap !== 'skip' && input.overlap !== 'allow') {
      return { ok: false, code: 'INVALID_SCHEDULE', message: `overlap must be "skip" or "allow", not "${String(input.overlap)}"` };
    }

    if (typeof input.createdBy !== 'string' || input.createdBy.trim() === '') {
      return { ok: false, code: 'INVALID_SCHEDULE', message: 'createdBy is required — a schedule mints cards with no human present at fire time, so it needs a recorded human owner up front' };
    }

    const id = newId('sch');
    const now = this.now();
    const nextFire = nextFireAt(parsed.rule, input.timezone, now);
    this.sql.exec(
      `INSERT INTO schedules
        (id, enabled, title, spec_json, priority, labels, stage_key, rule, timezone, overlap,
         next_fire_at, last_fired_at, last_card_id, skip_count, created_by, created_at, queued_grant)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`,
      id,
      input.enabled === false ? 0 : 1,
      input.title,
      JSON.stringify(input.spec ?? {}),
      input.priority ?? 0,
      JSON.stringify(input.labels ?? []),
      input.stageKey ?? null,
      input.rule,
      // Stored exactly as typed — never the resolved spelling.
      input.timezone,
      input.overlap,
      nextFire,
      input.createdBy,
      now,
      input.queuedGrant ? JSON.stringify(input.queuedGrant) : null,
    );
    const view = this.mustGetSchedule(id);
    this.emit('schedule.created', { schedule: view });
    return { ok: true, value: view };
  }

  /**
   * Edit a schedule. Changing `rule` or `timezone` recomputes `next_fire_at` from now — it must
   * not silently keep a fire time computed from the rule or zone being replaced.
   */
  async updateSchedule(
    id: string,
    patch: {
      title?: string;
      rule?: string;
      timezone?: string;
      overlap?: 'skip' | 'allow';
      spec?: JsonValue;
      priority?: number;
      labels?: string[];
      stageKey?: string | null;
      enabled?: boolean;
    },
  ): Promise<Result<ScheduleView>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    const existing = this.getScheduleRow(id);
    if (!existing) return { ok: false, code: 'SCHEDULE_NOT_FOUND', message: `schedule not found: ${id}` };

    const rule = patch.rule ?? (existing.rule as string);
    const timezone = patch.timezone ?? (existing.timezone as string);
    const ruleOrZoneChanged = patch.rule !== undefined || patch.timezone !== undefined;

    // Re-parsed here (not reused from creation) because either half of the pair may be new: a
    // changed rule needs re-validating, and an unchanged rule needs re-validating too when the zone
    // it is read against changes, since `nextFireAt` recomputes from both together.
    let reparsed: ReturnType<typeof parseRule> | null = null;
    if (ruleOrZoneChanged) {
      reparsed = parseRule(rule);
      if (!reparsed.ok) return { ok: false, code: 'INVALID_RULE', message: reparsed.error };
      if (patch.timezone !== undefined) {
        try {
          new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
        } catch {
          return { ok: false, code: 'INVALID_TIMEZONE', message: `"${timezone}" is not a time zone this runtime knows` };
        }
      }
    }

    if (patch.stageKey && !this.stages().some((s) => s.key === patch.stageKey)) {
      return { ok: false, code: 'UNKNOWN_STAGE', message: `unknown stage: ${patch.stageKey}` };
    }

    if (patch.overlap !== undefined && patch.overlap !== 'skip' && patch.overlap !== 'allow') {
      return { ok: false, code: 'INVALID_SCHEDULE', message: `overlap must be "skip" or "allow", not "${String(patch.overlap)}"` };
    }

    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.title !== undefined) { sets.push('title = ?'); vals.push(patch.title); }
    if (patch.spec !== undefined) { sets.push('spec_json = ?'); vals.push(JSON.stringify(patch.spec)); }
    if (patch.priority !== undefined) { sets.push('priority = ?'); vals.push(patch.priority); }
    if (patch.labels !== undefined) { sets.push('labels = ?'); vals.push(JSON.stringify(patch.labels)); }
    if (patch.stageKey !== undefined) { sets.push('stage_key = ?'); vals.push(patch.stageKey); }
    if (patch.overlap !== undefined) { sets.push('overlap = ?'); vals.push(patch.overlap); }
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0); }
    if (patch.rule !== undefined) { sets.push('rule = ?'); vals.push(patch.rule); }
    if (patch.timezone !== undefined) { sets.push('timezone = ?'); vals.push(patch.timezone); }
    // Must not silently keep a fire time computed from the rule or zone being replaced.
    if (reparsed && reparsed.ok) {
      sets.push('next_fire_at = ?');
      vals.push(nextFireAt(reparsed.rule, timezone, this.now()));
    }

    if (sets.length > 0) {
      this.sql.exec(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    }
    const view = this.mustGetSchedule(id);
    this.emit('schedule.updated', { schedule: view });
    return { ok: true, value: view };
  }

  async deleteSchedule(id: string): Promise<Result<{ id: string }>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    if (!this.getScheduleRow(id)) return { ok: false, code: 'SCHEDULE_NOT_FOUND', message: `schedule not found: ${id}` };
    this.sql.exec(`DELETE FROM schedules WHERE id = ?`, id);
    this.emit('schedule.deleted', { scheduleId: id });
    return { ok: true, value: { id } };
  }

  async listSchedules(): Promise<ScheduleView[]> {
    return this.sql
      .exec(`SELECT * FROM schedules ORDER BY created_at ASC`)
      .toArray()
      .map((r) => this.rowToSchedule(r));
  }

  /**
   * Create cards for every schedule whose time has come.
   *
   * Called from `sweepBoard`, which the Worker cron calls every five minutes — so a schedule may
   * fire up to five minutes late, and the UI says so next to the field.
   *
   * Idempotent by construction: `next_fire_at` advances in the same call that creates the card, so
   * a double tick finds nothing due. If the create throws, `next_fire_at` is left alone and the next
   * tick retries — at-least-once, which for a maintenance card is the right way round.
   *
   * Missed occurrences collapse to one. A board whose cron was down for a week produces one
   * "sweep the logs" card when it comes back, not seven. That is the right shape for maintenance
   * work, and it is exactly what a later reader "fixes" into a card storm — leave it alone.
   *
   * How that is achieved differs by rule kind, and the difference matters:
   *   - **clock rules** (daily/weekly/monthly) recompute the next wall-clock occurrence after now,
   *     so they are self-correcting;
   *   - **interval rules** advance by whole intervals from the PREVIOUS `next_fire_at` until past
   *     now (`advanceFireTime`), which collapses the backlog in one step AND keeps the phase.
   *
   * Advancing an interval rule from `nowIso` instead — the sweep instant, always a little after the
   * scheduled one — looks equivalent and is not: each cycle absorbs that lateness permanently, so
   * `every 5 minutes` becomes every 5 or 10, drifting without bound. That was a real defect here,
   * found by review rather than by a test, which is why this paragraph is longer than it looks
   * like it needs to be.
   */
  async fireDueSchedules(nowIso: string): Promise<{ fired: string[]; skipped: string[] }> {
    const due = this.sql
      .exec(`SELECT * FROM schedules WHERE enabled = 1 AND next_fire_at <= ? ORDER BY next_fire_at ASC`, nowIso)
      .toArray();

    const fired: string[] = [];
    const skipped: string[] = [];

    for (const row of due) {
      const id = row.id as string;
      // Principle 3: every card has a human owner. A schedule with no recorded creator cannot
      // produce one, so it is disabled rather than allowed to mint ownerless cards. `createdBy` is
      // required at creation, so this can only be a row predating that — it is not a normal state.
      if (!row.created_by) {
        this.sql.exec(`UPDATE schedules SET enabled = 0 WHERE id = ?`, id);
        this.emit('schedule.disabled', { scheduleId: id, reason: 'no creator recorded; cannot own a card' });
        continue;
      }
      const parsed = parseRule(row.rule as string);
      if (!parsed.ok) {
        // A rule that no longer parses cannot fire and must not be retried every five minutes
        // forever. Disable it and say so, loudly, on the event log.
        this.sql.exec(`UPDATE schedules SET enabled = 0 WHERE id = ?`, id);
        this.emit('schedule.disabled', { scheduleId: id, reason: parsed.error });
        continue;
      }

      if ((row.overlap as string) === 'skip' && this.scheduleInstanceOpen(row.last_card_id as string | null)) {
        this.sql.exec(
          `UPDATE schedules SET skip_count = skip_count + 1, next_fire_at = ? WHERE id = ?`,
          nextFireAt(parsed.rule, row.timezone as string, nowIso),
          id,
        );
        // Visible, not silent. A schedule quietly skipping for a month is the failure this guards.
        this.emit('schedule.skipped', { scheduleId: id, openCardId: row.last_card_id, at: nowIso });
        skipped.push(id);
        continue;
      }

      const created = await this.createCardFromTrigger({
        title: row.title as string,
        ownerUserId: row.created_by as string,
        // The grant captured when the schedule was created (`createSchedule`'s `queuedGrant`).
        // `createCardFromTrigger` falls back to `triggerGrant()` when this is `undefined` OR
        // `null` (`??` treats both as nullish) — that fallback is what a board's GitHub-webhook
        // grant covers, and is exactly the wrong one to lean on here: it has exactly one writer
        // (`PUT /v1/boards/:id/github`), so a board whose operator never saved GitHub settings has
        // `null` there, and under enforcement the card would park in `input-required` on first
        // claim, forever — `scheduleInstanceOpen` then reads the instance as open forever too,
        // silencing the schedule behind its own default `overlap: 'skip'`. A row predating this
        // column has `queued_grant IS NULL`, which is exactly the same fallback behaviour a
        // schedule with no queuedGrant supplied at creation gets — nothing regresses for it.
        queuedGrant: row.queued_grant ? (JSON.parse(row.queued_grant as string) as string[]) : undefined,
        spec: { ...(JSON.parse(row.spec_json as string) as Record<string, unknown>), scheduleId: id },
      });
      if (!created.ok) {
        // next_fire_at is deliberately NOT advanced: the next tick tries again.
        this.emit('schedule.failed', { scheduleId: id, reason: created.code });
        continue;
      }

      const cardId = created.value.card.id;
      // `moveCard` returns a Result and does NOT throw for the realistic failures — `UNKNOWN_STAGE`
      // (a stage renamed or removed by `setStages` after this schedule was written) and
      // `WIP_LIMIT`. Discarding it means the card lands in the default lane, `schedule.fired` is
      // emitted as a success, and nothing anywhere records that the routing was dropped. That is
      // the same silent failure this task exists to prevent, wearing a different hat.
      if (row.stage_key) {
        const moved = await this.moveCard(cardId, row.stage_key as string, row.created_by as string);
        if (!moved.ok) this.emit('schedule.stage_failed', { scheduleId: id, cardId, stageKey: row.stage_key, reason: moved.code });
      }
      if (Number(row.priority) !== 0 || (row.labels as string) !== '[]') {
        // Checked for the same reason `moveCard`'s Result is checked just above: an unchecked
        // Result reads as a fix half-applied. In practice `updateCard` can only fail here with
        // `NOT_INITIALIZED` (the board this schedule just fired on) or `CARD_NOT_FOUND` (the card
        // `createCardFromTrigger` just created, moments ago) — neither realistic on this path — but
        // "cannot fail today" is not the same guarantee as "checked", and the next caller to touch
        // this block should not have to re-derive that.
        const updated = await this.updateCard(cardId, {
          priority: Number(row.priority),
          labels: JSON.parse(row.labels as string) as string[],
        });
        if (!updated.ok) this.emit('schedule.card_update_failed', { scheduleId: id, cardId, reason: updated.code });
      }

      // `advanceFireTime`, not `nextFireAt(parsed.rule, row.timezone, nowIso)`: `nowIso` is the
      // sweep instant, always a little after the instant that was actually due, and pure addition
      // from it bakes that lateness into the phase forever — `every 5 minutes` drifts into "every
      // 5 or 10, unpredictably". Advancing by whole intervals from the PREVIOUS `next_fire_at`
      // keeps the phase and still collapses a missed week into one card. Clock rules are immune
      // and `advanceFireTime` delegates to the same wall-clock computation for them unchanged.
      this.sql.exec(
        `UPDATE schedules SET next_fire_at = ?, last_fired_at = ?, last_card_id = ? WHERE id = ?`,
        advanceFireTime(parsed.rule, row.timezone as string, row.next_fire_at as string, nowIso),
        nowIso,
        cardId,
        id,
      );
      this.emit('schedule.fired', { scheduleId: id, cardId, at: nowIso });
      fired.push(id);
    }

    return { fired, skipped };
  }

  /**
   * Is the previous instance of a schedule still open? Absent or resolved both mean "go ahead".
   *
   * All four terminal states count as closed here — deliberately different from the
   * blocker-resolution rule a later phase introduces, where only `completed` and `canceled` count
   * as resolved, because a blocker that failed must keep its dependent blocked. A schedule's own
   * previous instance is not a blocker: if it `failed`, the schedule must not wedge forever, so
   * this helper is NOT shared with that later rule and does not use `isTerminal()`.
   */
  private scheduleInstanceOpen(lastCardId: string | null): boolean {
    if (!lastCardId) return false;
    const row = this.sql.exec(`SELECT state, archived_at FROM cards WHERE id = ?`, lastCardId).toArray()[0];
    if (!row) return false; // the card was deleted; nothing to wait for
    if (row.archived_at) return false;
    const state = row.state as string;
    return state !== 'completed' && state !== 'canceled' && state !== 'rejected' && state !== 'failed';
  }

  /**
   * The per-board cron arm, called from the Worker's `scheduled()` every five minutes.
   *
   * It is here rather than on the DO alarm deliberately: a Durable Object has exactly one alarm and
   * this one already serves two jobs (lease reclaim and push drain — see `scheduleReclaim`). The
   * Worker cron already iterates every board, so this costs no new infrastructure.
   *
   * Three jobs share this sweep now: the once-per-board backfill above, the overdue notification
   * query below, and `fireDueSchedules`. Each is isolated from the other two — a failure in one
   * must not silently disable the others, which is exactly the failure mode Phase 1's whole-branch
   * review found here (a failing backfill had been taking the overdue sweep down with it, silently
   * and forever). `schedulesFired` reports 0, honestly, when firing itself failed.
   */
  async sweepBoard(nowIso: string): Promise<{ overdueNotified: number; schedulesFired: number; staleNotified: number }> {
    // The backfill is a migration, not a sweep job. Guarded by a meta flag because its query
    // (`WHERE due_at IS NULL`) matches every card that never had a due date — i.e. most of them,
    // forever — so running it on each five-minute tick would be a full table scan for nothing.
    // A board whose backfill can never succeed (e.g. a missing tenant row `backfillLabelNames`
    // needs) must not lose its overdue sweep forever — that would silently kill notifications AND
    // re-scan the whole card table every five minutes. So the backfill's own failure is caught
    // here and deferred past the overdue query below, rather than aborting the whole sweep before
    // it runs. The flag stays unset on failure — a failure still retries the whole pass next
    // sweep, which is deliberate and tested (`backfillLabelNames` above) — but the deferred error
    // is re-thrown at the end so a caller still sees the sweep failed.
    /**
     * Cards stranded in a terminal stage nobody can act on, resolved once per board.
     *
     * Its OWN flag, not `dueBackfillDone`'s: that flag is already set on every existing board, so
     * sharing it would mean this migration never ran anywhere it is needed — which is every board
     * made from a shipped template. Guarded for the same reason the other is, and in its own
     * try/catch for the reason this sweep's comments give three times over: one job's failure must
     * not abort the two after it.
     */
    let terminalBackfillError: unknown = null;
    if (!this.getMeta('terminalBackfillDone')) {
      try {
        const { completed } = await this.backfillTerminalStageCards();
        this.setMeta('terminalBackfillDone', '1');
        if (completed > 0) this.emit('cards.terminal_backfilled', { completed });
      } catch (err) {
        terminalBackfillError = err;
      }
    }

    let backfillError: unknown = null;
    if (!this.getMeta('dueBackfillDone')) {
      try {
        const { migrated } = await this.backfillDueDates();
        // Same guard, same pass: a card's legacy `spec.labels` is the other half of "two sources of
        // truth for one fact" this flag exists to close. If either backfill throws, the flag below
        // is never set — a failure retries the whole pass next sweep rather than skipping either
        // migration forever. Both backfills are individually idempotent, so a retried
        // `backfillDueDates` after a `backfillLabelNames` failure costs nothing extra.
        const { migrated: labelsMigrated } = await this.backfillLabelNames();
        this.setMeta('dueBackfillDone', '1');
        if (migrated > 0) this.emit('cards.due_backfilled', { migrated });
        if (labelsMigrated > 0) this.emit('cards.labels_backfilled', { migrated: labelsMigrated });
      } catch (err) {
        backfillError = err;
      }
    }

    // Its own try/catch too, for the same reason the backfill and `fireDueSchedules` below each
    // have one: three jobs share this sweep, and the comment above claims all three are isolated
    // — a claim a whole-branch review found false for this block specifically. Before this, a
    // throw here (e.g. from `notify`) aborted the sweep before `fireDueSchedules` ever ran,
    // reintroducing Phase 1's failure shape one slot lower. `overdueNotified` is reported as
    // however many were notified before a failure, which is honest — that many were.
    let overdueNotified = 0;
    try {
      const today = nowIso.slice(0, 10); // the column is a date, so compare dates
      const rows = this.sql
        .exec(
          `SELECT id, title, due_at FROM cards
            WHERE due_at IS NOT NULL AND due_at < ?
              AND archived_at IS NULL
              AND overdue_notified_at IS NULL
              AND state NOT IN ('completed', 'canceled', 'rejected', 'failed')`,
          today,
        )
        .toArray();

      for (const row of rows) {
        this.notify('overdue', row.id as string, `"${row.title as string}" was due ${row.due_at as string}`);
        this.sql.exec(`UPDATE cards SET overdue_notified_at = ? WHERE id = ?`, nowIso, row.id as string);
        overdueNotified += 1;
      }
    } catch (err) {
      this.emit('overdue.sweep_failed', { reason: String(err) });
    }

    // Its own try/catch, for the reason the backfill above has one: three jobs share this sweep, and
    // a failure in any of them must not silently disable the other two. `schedulesFired` is still
    // reported as 0 when firing failed, which is honest — nothing fired.
    let schedulesFired = 0;
    try {
      schedulesFired = (await this.fireDueSchedules(nowIso)).fired.length;
    } catch (err) {
      this.emit('schedules.sweep_failed', { reason: String(err) });
    }

    // The stale digest, isolated like the jobs above it: its failure must cost none of them.
    let staleNotified = 0;
    try {
      staleNotified = this.sendStaleDigest(nowIso);
    } catch (err) {
      this.emit('stale.sweep_failed', { reason: String(err) });
    }

    // The overdue sweep and schedule firing above ran regardless of the backfill's outcome. Now
    // that they have, surface the deferred failure so a caller (the cron loop) still learns the
    // sweep was not clean.
    if (backfillError) throw backfillError;
    // Reported after the sweep's own work, same as `backfillError` above: a migration that failed
    // must be visible to the caller, and must not have cost the overdue pass or the schedules.
    if (terminalBackfillError) throw terminalBackfillError;

    return { overdueNotified, schedulesFired, staleNotified };
  }

  // ----- stale cards -----

  async setStaleSettings(input: { enabled?: boolean; afterHours?: number }): Promise<Result<StaleSettings>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      return { ok: false, code: 'INVALID_STALE_SETTINGS', message: '`enabled` must be true or false' };
    }
    if (input.afterHours !== undefined && (typeof input.afterHours !== 'number' || !Number.isFinite(input.afterHours) || input.afterHours < 0)) {
      return { ok: false, code: 'INVALID_STALE_SETTINGS', message: '`afterHours` must be a number of hours, 0 or more' };
    }
    if (input.enabled !== undefined) this.setMeta('staleEnabled', input.enabled ? '1' : '0');
    if (input.afterHours !== undefined) this.setMeta('staleAfterHours', String(input.afterHours));
    this.emit('board.stale_settings', { ...this.staleSettings() });
    return { ok: true, value: this.staleSettings() };
  }

  private staleSettings(): StaleSettings {
    const hours = Number(this.getMeta('staleAfterHours'));
    return {
      enabled: this.getMeta('staleEnabled') !== '0',
      afterHours: this.getMeta('staleAfterHours') !== null && Number.isFinite(hours) ? hours : STALE_DEFAULT_HOURS,
    };
  }

  /**
   * Cards waiting past a threshold, oldest first.
   *
   * With no `afterHours` the board's own setting applies, and a board that switched stale cards off
   * lists nothing. An explicit threshold is a person asking directly, and is answered whatever the
   * switch says: the switch silences the board, it does not hide its cards.
   */
  async staleCards(input: { nowIso: string; afterHours?: number; attention?: boolean }): Promise<StaleCardView[]> {
    return this.collectStale(input);
  }

  /**
   * `attention`: the Needs-you feed rather than the stale list. Every card waiting on a person, at
   * any age — those want an answer now, not tomorrow — plus cards in an ownerless stage once they
   * pass the board's threshold (before it, a card in an intake column is just backlog), and only
   * while the board reports stale cards at all.
   */
  private collectStale(input: { nowIso: string; afterHours?: number; attention?: boolean }): StaleCardView[] {
    const boardId = this.getMeta('boardId');
    if (!boardId) return [];
    const settings = this.staleSettings();
    if (input.afterHours === undefined && !input.attention && !settings.enabled) return [];
    const afterHours = input.afterHours ?? settings.afterHours;
    const nowMs = Date.parse(input.nowIso);
    const stages = this.stages();
    const last = stages[stages.length - 1]?.key;
    // Stages nothing will ever take a submitted card from. The last stage is excluded because
    // arriving there resolves the card (`completesOnArrival`).
    const ownerless = stages.filter((st) => !this.isAgentClaimable(st) && st.gate !== 'approval' && st.key !== last).map((st) => st.key);
    const placeholders = ownerless.map(() => '?').join(', ');
    const rows = this.sql
      .exec(
        `SELECT * FROM cards WHERE archived_at IS NULL AND (state = 'input-required'
           ${ownerless.length > 0 ? `OR (state = 'submitted' AND current_stage_key IN (${placeholders}))` : ''})`,
        ...ownerless,
      )
      .toArray();
    const out: StaleCardView[] = [];
    for (const row of rows) {
      const since = ((row.state_since as string | null) ?? (row.updated_at as string | null) ?? (row.created_at as string));
      const ageMs = nowMs - Date.parse(since);
      const waitingOnPerson = (row.state as string) === 'input-required';
      if (!(input.attention && waitingOnPerson)) {
        if (input.attention && !settings.enabled) continue;
        if (!(ageMs >= afterHours * 3600_000)) continue;
      }
      const card = this.rowToCard(row);
      const stage = stages.find((st) => st.key === card.currentStageKey);
      const why = this.staleWhy(card, row);
      out.push({
        boardId,
        boardName: this.getMeta('name') ?? '',
        cardId: card.id,
        title: card.title,
        ownerUserId: card.ownerUserId,
        stageKey: card.currentStageKey,
        stageName: stage?.name ?? card.currentStageKey,
        state: card.state,
        why,
        summary: handoffSummary((row.handoff_json as string | null) ?? null),
        since,
        ageHours: Math.floor((ageMs / 3600_000) * 10) / 10,
        next: this.staleNext(boardId, card, why),
      });
    }
    return out.sort((a, b) => a.since.localeCompare(b.since));
  }

  private staleWhy(card: CardView, row: Row): StaleCardView['why'] {
    if (card.state !== 'input-required') return { kind: 'no-owner' };
    const gate = this.sql.exec(`SELECT id FROM gates WHERE card_id = ? AND status = 'pending' LIMIT 1`, card.id).toArray()[0];
    const needs = card.needsHuman;
    if (needs) {
      return {
        kind: 'needs-human',
        reason: needs.reason,
        ...(needs.detail !== undefined ? { detail: needs.detail } : {}),
        ...(needs.failureCount !== undefined ? { failureCount: needs.failureCount } : {}),
        ...(needs.elicitationId !== undefined ? { elicitationId: needs.elicitationId } : {}),
        ...(gate ? { gateId: gate.id as string } : {}),
      };
    }
    // The two parks that predate `needsHuman`: a review gate opened on entry, and a deferred advance.
    if (gate) return { kind: 'needs-human', reason: 'review', gateId: gate.id as string };
    if (row.pending_advance_json) return { kind: 'needs-human', reason: 'sub-tasks', detail: 'waiting on its open sub-tasks' };
    return { kind: 'needs-human', reason: 'blocked' };
  }

  private staleNext(boardId: string, card: CardView, why: StaleCardView['why']): string {
    const resume = `supi resume ${boardId} ${card.id} --comment "what changed"`;
    if (why.kind === 'no-owner') {
      return `nothing claims stage "${card.currentStageKey}" — move it to a stage someone works (supi move ${boardId} ${card.id} <stage>), or give the stage an owner`;
    }
    switch (why.reason) {
      case 'question':
        return "answer the agent's question on the card";
      case 'review':
        return why.gateId
          ? `decide the review: supi approve ${boardId} ${why.gateId}, or supi request-changes ${boardId} ${why.gateId} --comment "…"`
          : 'decide the review on the card';
      case 'sub-tasks':
        return 'finish or remove its open sub-tasks';
      case 'not-authorised':
        return `resume it as someone allowed to dispatch this work: ${resume}`;
      default:
        return `read why it stopped, fix that, then resume it: ${resume}`;
    }
  }

  /**
   * The daily digest: each stale card's owner is told once, and every push config that subscribed
   * to `cards.stale` gets one delivery listing them. Quiet when there is nothing new to say; a card
   * already told about in the last 24 hours is left out (`stale_notified_at`).
   */
  private sendStaleDigest(nowIso: string): number {
    const nowMs = Date.parse(nowIso);
    const due = this.collectStale({ nowIso }).filter((c) => {
      const row = this.sql.exec(`SELECT stale_notified_at FROM cards WHERE id = ?`, c.cardId).toArray()[0];
      const last = (row?.stale_notified_at as string | null | undefined) ?? null;
      return last === null || nowMs - Date.parse(last) >= STALE_DIGEST_REPEAT_MS;
    });
    if (due.length === 0) return 0;
    for (const c of due) {
      const why = c.why.kind === 'no-owner' ? `nothing claims stage "${c.stageKey}"` : c.why.detail ?? c.why.reason;
      this.notify('stale', c.cardId, `Stuck ${Math.floor(c.ageHours)}h in ${c.stageName}: ${why}. Next: ${c.next}`);
      this.sql.exec(`UPDATE cards SET stale_notified_at = ? WHERE id = ?`, nowIso, c.cardId);
    }
    const body = JSON.stringify({
      event: 'cards.stale',
      boardId: this.getMeta('boardId'),
      boardName: this.getMeta('name') ?? '',
      cards: due,
      ts: nowIso,
    });
    for (const cfg of this.sql.exec(`SELECT * FROM push_configs`).toArray()) {
      const events = JSON.parse(cfg.events_json as string) as string[];
      if (!events.includes('cards.stale')) continue;
      this.sql.exec(
        `INSERT INTO push_deliveries (config_id, url, body, status, attempts, created_at) VALUES (?, ?, ?, 'pending', 0, ?)`,
        cfg.id,
        cfg.url,
        body,
        this.now(),
      );
    }
    this.emit('cards.stale_digest', { count: due.length, cardIds: due.map((c) => c.cardId) });
    return due.length;
  }


  /**
   * Queue `work.available` deliveries for a claimable card, only to configs that could actually claim
   * it (docs/05 §4): a capability stage targets configs advertising that capability; an agent-owned
   * stage targets only that agent. No pings while the board is over budget (claim would refuse).
   */
  private notifyWorkAvailable(cardId: string): void {
    const card = this.getCard(cardId);
    // `state`/`archivedAt` mirror `claimableWhere`'s own conditions, by hand: this is a JS
    // predicate over a `CardView`, not SQL, so it cannot call that helper directly. The blocked
    // rule (unresolved `blocks`, open `parent` child) no longer needs its own hand-copy, though —
    // it comes from the same `blockedWhere()` fragment `claimableWhere` uses, via `isHeldBack`, so
    // the two cannot drift apart the way the archived check once risked. Any FUTURE eligibility
    // condition added to `claimableWhere` still needs its equivalent added here too, or a push
    // fires for work `claim` will refuse.
    if (!card || card.state !== 'submitted' || card.archivedAt || this.isHeldBack(cardId)) return;
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
  /**
   * One gate, including how it was decided.
   *
   * Gates were readable two ways and neither served the caller that needed this. `gates/pending`
   * answers only what is still waiting; the board snapshot is a human route. So a hub that had
   * posted a gate into a chat room had no way to learn it had since been decided on the web, or
   * what the decision was — and that room went on offering Approve and Reject for a decision
   * already made, with no expiry (agentpod: the sweep that settles those).
   */
  async getGate(gateId: string): Promise<Result<GateView>> {
    const row = this.getGateRow(gateId);
    if (!row) return { ok: false, code: 'GATE_NOT_FOUND', message: `gate not found: ${gateId}` };
    return { ok: true, value: this.rowToGate(row) };
  }

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

  /**
   * The WHERE fragment deciding whether a card may be handed out, shared by the claim query and the
   * work-discovery count so the two cannot drift apart.
   *
   * They were independent copies of `state = 'submitted' AND current_stage_key IN (…)`. Every
   * condition added to claim from here on — archived here, blocked and parent-with-open-children via
   * `blockedWhere()` (Task 13) — has to be invisible to `list_work` as well, or the board advertises
   * work it will not hand out. The table is aliased `c` in both callers so this fragment can qualify
   * its columns.
   */
  private claimableWhere(placeholders: string): string {
    return `c.state = 'submitted' AND c.archived_at IS NULL
      AND c.current_stage_key IN (${placeholders})
      AND ${this.blockedWhere()}`;
  }

  /**
   * The one spelling of "resolved", as SQL — interpolated into every WHERE clause below that asks
   * it (`blockedWhere`'s two conditions, `openChildCount`, `unresolvedBlockerCount`), so the rule
   * has a single place to change instead of four string literals that could drift independently.
   *
   * A blocker/child is resolved only when it is `completed` or `canceled` — **not** all four
   * terminal states. `TERMINAL_STATES` also contains `rejected` and `failed`; either must keep its
   * dependent blocked, or the edge does nothing in the situation it exists for. This is the SQL
   * form of `isResolved` (`links.ts`) — that function is its JS twin (currently unused in this DO,
   * since every check here is a SQL WHERE clause, not a JS predicate), kept for parity and for any
   * future caller that needs the rule outside SQL. Do not widen this to `isTerminal()` or the four
   * terminal states — the `'keeps the dependent blocked while the blocker is rejected…'` test in
   * `links-enforcement.test.ts` exists to catch exactly that (the mid-retry test does not: a
   * mid-retry blocker is `submitted`, which is unresolved under either rule, so it can't tell the
   * two apart).
   */
  private static readonly RESOLVED_SQL = "('completed', 'canceled')";

  /**
   * An unresolved `blocks` edge pointing at `c.id` — the enforced dependency. Correlated on the
   * alias `c`, so it only composes where the cards table is aliased `c` (`blockedWhere`,
   * `isHeldBack`). Extracted (Task 17) so `CardView.blockedBy`'s batch query can select the same
   * blocker rows this EXISTS clause tests for, instead of restating the predicate.
   */
  private unresolvedBlockerExists(): string {
    return `EXISTS (
        SELECT 1 FROM card_links l
          JOIN cards b ON b.id = l.from_card_id
         WHERE l.to_card_id = c.id AND l.kind = 'blocks'
           AND b.state NOT IN ${BoardDO.RESOLVED_SQL}
      )`;
  }

  /**
   * An unresolved child of `c.id` (the `parent` edge) — surfaced to readers as `openChildCount`,
   * never as a `blockedBy` entry: it is a different fact with a different badge. Extracted (Task 17)
   * alongside `unresolvedBlockerExists` so `blockedWhere` composes from two named fragments instead
   * of two inline `NOT EXISTS` clauses.
   */
  private openChildExists(): string {
    return `EXISTS (
        SELECT 1 FROM card_links l
          JOIN cards ch ON ch.id = l.to_card_id
         WHERE l.from_card_id = c.id AND l.kind = 'parent'
           AND ch.state NOT IN ${BoardDO.RESOLVED_SQL}
      )`;
  }

  /**
   * Whether nothing holds `c` back from being handed out: no unresolved blocker (`blocks`), and no
   * open child (`parent`). Parameterless and correlated on the alias `c`, so it composes directly
   * into `claimableWhere`'s SELECT and into `isHeldBack`'s single-card check below, without either
   * restating the rule. TRUE means eligible — `claimableWhere` ANDs it straight into its WHERE
   * clause, and `isHeldBack` inverts the question to ask it about one card.
   *
   * One definition, three readers — the claim query (via `claimableWhere`), the discovery count
   * (`countReadyForCapabilities`, which calls `claimableWhere` too), and `notifyWorkAvailable`'s JS
   * gate, which reaches it through `isHeldBack` rather than mirroring the SQL by hand. A fourth
   * reader, `CardView.blockedBy`, reuses `unresolvedBlockerExists`'s predicate directly rather than
   * this composed form — it needs the `blocks` half only, never the `parent` half.
   */
  private blockedWhere(): string {
    return `NOT ${this.unresolvedBlockerExists()} AND NOT ${this.openChildExists()}`;
  }

  /** The same rule, asked about one card, for callers that are not a SELECT over the stage set. */
  private isHeldBack(cardId: string): boolean {
    return (
      this.sql.exec(`SELECT 1 FROM cards c WHERE c.id = ? AND (${this.blockedWhere()})`, cardId).toArray().length ===
      0
    );
  }

  /**
   * Every card this one directly holds back: the cards it blocks (`blocks`, this card as source),
   * and its own parent, if it has one (`parent`, this card as the child/target) — a parent may now
   * have lost its last open child. Called once a card reaches a genuinely resolved state
   * (`completed`/`canceled`), to re-issue `work.available` pings that `notifyWorkAvailable`
   * correctly suppressed while this card was still open. Without this fan-out, a push-subscribed
   * agent waiting on a dependent never hears that it unblocked — only `list_work` polling would
   * ever find it, which is the same shape of silent gap Phase 1 fixed for the archived exclusion.
   *
   * `notifyWorkAvailable` re-checks eligibility itself (`isHeldBack`, stage ownership, budget), so
   * calling it here for a card that is STILL blocked by something else (e.g. a second unresolved
   * blocker) is safe — it just no-ops.
   */
  private notifyDependents(cardId: string): void {
    for (const row of this.sql.exec(`SELECT to_card_id FROM card_links WHERE from_card_id = ? AND kind = 'blocks'`, cardId).toArray()) {
      this.notifyWorkAvailable(row.to_card_id as string);
    }
    const parentId = this.parentIdOf(cardId);
    if (parentId) this.notifyWorkAvailable(parentId);
  }

  /**
   * `cardId`'s parent, via its `parent` edge (`cardId` as `to_card_id`) — or null if it has none.
   * One spelling of the lookup, used by `CardView.parentCardId` (`rowToCard`), `notifyDependents`'s
   * fan-out, and `resumeDeferredParentAdvance`'s trigger (Task 14).
   */
  private parentIdOf(cardId: string): string | null {
    return (
      (this.sql
        .exec(`SELECT from_card_id FROM card_links WHERE to_card_id = ? AND kind = 'parent'`, cardId)
        .toArray()[0]?.from_card_id as string | undefined) ?? null
    );
  }

  /**
   * How many of `cardId`'s children (via the `parent` edge, `cardId` as source) are still
   * unresolved. Originally used only by `moveCard`'s advance refusal — deliberately NOT
   * `blockedWhere()`, which also folds in the `blocks` condition that `moveCard` must NOT refuse on
   * (Principle 3). Task 14 gave it two more callers: `advanceCard`'s deferral (the same "is this
   * card held back by an open child" question, asked of the agent path) and `CardView.openChildCount`
   * (`rowToCard`), a read-only surfacing of the same count for the UI.
   */
  private openChildCount(cardId: string): number {
    return Number(
      this.sql
        .exec(
          `SELECT COUNT(*) AS n FROM card_links l JOIN cards ch ON ch.id = l.to_card_id
            WHERE l.from_card_id = ? AND l.kind = 'parent' AND ch.state NOT IN ${BoardDO.RESOLVED_SQL}`,
          cardId,
        )
        .one().n,
    );
  }

  /**
   * `cardId`'s open children (via the `parent` edge), id and title, oldest first — for the
   * deferred-advance park notification (`advanceCard`). A card can be "open" here forever without
   * ever resolving: `rejected` is deliberately outside `RESOLVED_SQL` (a rejected blocker must keep
   * blocking, same reasoning as a failed one), and an archived child is excluded from `claimableWhere`
   * so it can never be claimed to completion either. Both are recoverable with existing verbs
   * (delete the child, `removeLink` it, un-archive and finish it), but neither is visible from the
   * parked parent alone — hence naming the children, not just the count.
   */
  private openChildren(cardId: string): { id: string; title: string }[] {
    return this.sql
      .exec(
        `SELECT ch.id, ch.title FROM card_links l JOIN cards ch ON ch.id = l.to_card_id
           WHERE l.from_card_id = ? AND l.kind = 'parent' AND ch.state NOT IN ${BoardDO.RESOLVED_SQL}
           ORDER BY ch.created_at ASC`,
        cardId,
      )
      .toArray()
      .map((r) => ({ id: r.id as string, title: r.title as string }));
  }

  /**
   * How many unresolved blockers (via the `blocks` edge, `cardId` as target) `cardId` has. Used
   * only to decide whether `moveCard`'s human-override notification fires — a `blocks` edge never
   * refuses the move itself.
   */
  private unresolvedBlockerCount(cardId: string): number {
    return Number(
      this.sql
        .exec(
          `SELECT COUNT(*) AS n FROM card_links l JOIN cards b ON b.id = l.from_card_id
            WHERE l.to_card_id = ? AND l.kind = 'blocks' AND b.state NOT IN ${BoardDO.RESOLVED_SQL}`,
          cardId,
        )
        .one().n,
    );
  }

  /**
   * `cardId`'s unresolved blockers (the `blocks` edge, `cardId` as target), id and title — the same
   * `kind = 'blocks'` + `RESOLVED_SQL` predicate as `unresolvedBlockerExists()`, as a SELECT rather
   * than an EXISTS, for `CardView.blockedBy`'s single-card fallback (`rowToCard`, no `pre`). The
   * batched board read (`allCards`) asks this same question in one grouped query instead of calling
   * this once per card — see the note on `blockersByCard` there.
   */
  private blockersOf(cardId: string): Array<{ cardId: string; title: string }> {
    return this.sql
      .exec(
        `SELECT b.id, b.title FROM card_links l JOIN cards b ON b.id = l.from_card_id
          WHERE l.to_card_id = ? AND l.kind = 'blocks' AND b.state NOT IN ${BoardDO.RESOLVED_SQL}`,
        cardId,
      )
      .toArray()
      .map((r) => ({ cardId: r.id as string, title: r.title as string }));
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
        .exec(`SELECT COUNT(*) AS n FROM cards c WHERE ${this.claimableWhere(placeholders)}`, ...claimableKeys)
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
        ...this.commentsForRunContext(cardId),
      },
    };
  }

  // ----- card comments -----

  async listComments(cardId: string): Promise<Result<CommentView[]>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    if (!this.getCardRow(cardId)) return { ok: false, code: 'CARD_NOT_FOUND', message: `card not found: ${cardId}` };
    return { ok: true, value: this.commentRows(cardId) };
  }

  async addComment(input: { cardId: string; author: CommentView['author']; body: string }): Promise<Result<CommentView>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    if (!this.getCardRow(input.cardId)) return { ok: false, code: 'CARD_NOT_FOUND', message: `card not found: ${input.cardId}` };
    if (typeof input.body !== 'string' || input.body.trim() === '') {
      return { ok: false, code: 'INVALID_COMMENT', message: 'a comment needs a non-empty body' };
    }
    const bytes = new TextEncoder().encode(input.body).length;
    if (bytes > COMMENT_MAX_BYTES) {
      return { ok: false, code: 'INVALID_COMMENT', message: `a comment is at most ${COMMENT_MAX_BYTES} bytes; this one is ${bytes}` };
    }
    if (input.author.kind === 'agent') {
      const holds = this.sql
        .exec(`SELECT 1 FROM runs WHERE card_id = ? AND agent_id = ? AND status = 'working' LIMIT 1`, input.cardId, input.author.id)
        .toArray();
      if (holds.length === 0) {
        return { ok: false, code: 'NO_RUN_ON_CARD', message: 'an agent may comment only on a card its live run holds' };
      }
    }
    return { ok: true, value: this.writeComment(input.cardId, input.author, input.body) };
  }

  /**
   * Write a comment, with no say over whether this author may.
   *
   * `addComment` is the door, and it checks; this is the room behind it, for the board's own writes
   * on someone's behalf — a judge's findings land as the judge's comment after its run has ended,
   * which `addComment`'s live-run rule would refuse.
   */
  private writeComment(cardId: string, author: CommentView['author'], body: string): CommentView {
    const input = { cardId, author, body };
    const id = newId('cmt');
    // Strictly after the newest comment on this card: Workers freezes the clock inside a request,
    // and a thread ordered by a timestamp two comments share is a thread whose order is a guess.
    const last = this.sql
      .exec(`SELECT created_at FROM card_comments WHERE card_id = ? ORDER BY created_at DESC LIMIT 1`, input.cardId)
      .toArray()[0];
    const nowMs = Date.parse(this.now());
    const lastMs = last ? Date.parse(last.created_at as string) : Number.NaN;
    const createdAt = new Date(Number.isNaN(lastMs) ? nowMs : Math.max(nowMs, lastMs + 1)).toISOString();
    this.sql.exec(
      `INSERT INTO card_comments (id, card_id, author_kind, author_id, author_name, body, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      id,
      input.cardId,
      input.author.kind,
      input.author.id,
      input.author.name,
      input.body,
      createdAt,
    );
    // The event names the comment, never its text: the event log is kept for good, and a body
    // copied into it would outlive the author deleting it.
    this.emit('card.comment.added', { cardId: input.cardId, commentId: id, authorKind: input.author.kind });
    return this.commentRows(input.cardId).find((c) => c.id === id)!;
  }

  async deleteComment(input: { cardId: string; commentId: string; userId: string }): Promise<Result<CommentView>> {
    if (!this.getMeta('boardId')) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    const row = this.sql
      .exec(`SELECT * FROM card_comments WHERE id = ? AND card_id = ?`, input.commentId, input.cardId)
      .toArray()[0];
    if (!row) return { ok: false, code: 'COMMENT_NOT_FOUND', message: `comment not found: ${input.commentId}` };
    if ((row.author_kind as string) !== 'human' || (row.author_id as string) !== input.userId) {
      return { ok: false, code: 'NOT_COMMENT_AUTHOR', message: 'only the person who wrote a comment may delete it' };
    }
    if (!row.deleted_at) {
      this.sql.exec(`UPDATE card_comments SET body = '', deleted_at = ? WHERE id = ?`, this.now(), input.commentId);
      this.emit('card.comment.deleted', { cardId: input.cardId, commentId: input.commentId });
    }
    return { ok: true, value: this.commentRows(input.cardId).find((c) => c.id === input.commentId)! };
  }

  async listRunComments(input: { runId: string; agentId: string | null }): Promise<Result<CommentView[]>> {
    const row = this.getRunRow(input.runId);
    if (!row) return { ok: false, code: 'RUN_NOT_FOUND', message: `run not found: ${input.runId}` };
    const denied = this.denyForeignRun(row, input.agentId);
    if (denied) return denied;
    return this.listComments(row.card_id as string);
  }

  async addRunComment(input: { runId: string; agentId: string; agentName: string | null; body: string }): Promise<Result<CommentView>> {
    const row = this.getRunRow(input.runId);
    if (!row) return { ok: false, code: 'RUN_NOT_FOUND', message: `run not found: ${input.runId}` };
    const denied = this.denyForeignRun(row, input.agentId);
    if (denied) return denied;
    return this.addComment({
      cardId: row.card_id as string,
      author: { kind: 'agent', id: input.agentId, name: input.agentName },
      body: input.body,
    });
  }

  private commentRows(cardId: string): CommentView[] {
    return this.sql
      .exec(`SELECT * FROM card_comments WHERE card_id = ? ORDER BY created_at ASC, id ASC`, cardId)
      .toArray()
      .map((r) => ({
        id: r.id as string,
        cardId: r.card_id as string,
        author: {
          kind: r.author_kind as 'human' | 'agent',
          id: r.author_id as string,
          name: (r.author_name as string | null) ?? null,
        },
        body: r.body as string,
        createdAt: r.created_at as string,
        deletedAt: (r.deleted_at as string | null) ?? null,
      }));
  }

  /** The bounded slice of a card's thread a run context carries (see `RunContext.comments`). */
  private commentsForRunContext(cardId: string): { comments: CommentView[]; commentsOmitted: number } {
    const live = this.commentRows(cardId).filter((c) => c.deletedAt === null);
    const kept: CommentView[] = [];
    let bytes = 0;
    const enc = new TextEncoder();
    for (let i = live.length - 1; i >= 0 && kept.length < RUN_CONTEXT_COMMENTS; i--) {
      const size = enc.encode(live[i]!.body).length;
      if (bytes + size > RUN_CONTEXT_COMMENT_BYTES) break;
      bytes += size;
      kept.unshift(live[i]!);
    }
    return { comments: kept, commentsOmitted: live.length - kept.length };
  }

  async verifyApprovalSubject(input: {
    runId: string;
    leaseEpoch: number;
    agentId?: string | null;
    expectedSchema: string;
    expectedSubjectId: string;
    expectedDigest: string;
    expectedAccount: JsonValue;
  }): Promise<Result<ApprovalSubjectVerification>> {
    const auth = this.authorizeRun(input);
    if (!auth.ok) return auth;
    const boardId = this.getMeta('boardId');
    if (!boardId) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };

    const run = auth.run;
    const cardId = run.card_id as string;
    const cardRow = this.getCardRow(cardId);
    const subjectId = (cardRow?.active_approval_subject_id as string | null | undefined) ?? null;
    if (!cardRow || cardRow.current_stage_key !== run.stage_key || !subjectId) {
      return { ok: false, code: 'APPROVAL_SUBJECT_NOT_VERIFIED', message: 'the run is not bound to an active approval subject' };
    }

    const subjectRow = this.sql.exec(`SELECT * FROM approval_subjects WHERE id = ?`, subjectId).toArray()[0];
    const gate = this.sql
      .exec(`SELECT * FROM gates WHERE approval_subject_id = ? AND card_id = ? ORDER BY rowid DESC LIMIT 1`, subjectId, cardId)
      .toArray()[0];
    const subject = this.approvalSubjectView(subjectId);
    const stage = this.stages().find((candidate) => candidate.key === (run.stage_key as string));
    if (
      !subjectRow ||
      !subject ||
      subjectRow.status !== 'active' ||
      subjectRow.card_id !== cardId ||
      !gate ||
      gate.status !== 'resolved' ||
      !isApproveDecision(gate.decision as GateDecision) ||
      gate.decision === 'approve_manual' ||
      gate.approval_subject_digest !== subject.digest ||
      gate.stage_key !== subjectRow.gate_stage_key ||
      !gate.decided_by ||
      !gate.resolved_at ||
      !stage ||
      stage.ownerKind !== 'capability' ||
      !stageCapabilitiesMet(stage, ['x-publish'])
    ) {
      return { ok: false, code: 'APPROVAL_SUBJECT_NOT_VERIFIED', message: 'approval subject and gate binding is not valid' };
    }
    if (
      subject.schema !== input.expectedSchema ||
      input.expectedSubjectId !== subject.id ||
      input.expectedDigest !== subject.digest
    ) {
      return { ok: false, code: 'APPROVAL_SUBJECT_NOT_VERIFIED', message: 'approval subject does not match executor expectations' };
    }

    const canonical = record(subject.canonical);
    const account = canonical?.account as JsonValue | undefined;
    const timing = record(canonical?.timing);
    const projectId = (cardRow.project_id as string | null | undefined) ?? null;
    if (
      !account ||
      !timing ||
      !nonEmptyString(timing.expiresAt) ||
      !projectId ||
      canonical?.cardId !== cardId ||
      canonical.projectId !== projectId
    ) {
      return { ok: false, code: 'APPROVAL_SUBJECT_NOT_VERIFIED', message: 'approval subject lacks its card, project, account, or expiry binding' };
    }
    if (canonicalJson(input.expectedAccount) !== canonicalJson(account)) {
      return { ok: false, code: 'APPROVAL_SUBJECT_NOT_VERIFIED', message: 'approval subject account does not match executor expectations' };
    }
    if (Date.parse(timing.expiresAt) <= this.nowMs()) {
      return { ok: false, code: 'APPROVAL_SUBJECT_EXPIRED', message: 'approval subject has expired' };
    }

    return {
      ok: true,
      value: {
        boardId,
        projectId,
        cardId,
        runId: input.runId,
        stageKey: run.stage_key as string,
        canonicalBytesBase64: bytesBase64(storedBytes(subjectRow.canonical_bytes)),
        expiresAt: timing.expiresAt,
        subject: { ...subject, account },
        gate: {
          id: gate.id as string,
          decision: gate.decision as string,
          decidedBy: gate.decided_by as string,
          resolvedAt: gate.resolved_at as string,
        },
      },
    };
  }

  /**
   * A run as evidence (superwitness contract C4; charter evidence-joins-on-the-work-run decisions
   * 4 and 5). Read-only. Gates: those this run opened, plus legacy gates (null run_id) on the same
   * card whose `stage_key` is the run's stage or whose `return_stage_key` is (advanceCard opens a
   * gate on the NEXT stage and records the stage the work came from as its return stage). Usage: `unreported` with null numbers when no record exists — a
   * bridge-dispatched run's cost is not zero, it is unknown.
   */
  async getRunEvidence(runId: string): Promise<Result<RunEvidence>> {
    const boardId = this.getMeta('boardId');
    if (!boardId) return { ok: false, code: 'NOT_INITIALIZED', message: 'board is not initialized' };
    const row = this.getRunRow(runId);
    if (!row) return { ok: false, code: 'RUN_NOT_FOUND', message: `run not found: ${runId}` };
    const cardId = row.card_id as string;
    const card = this.getCard(cardId);
    // deleteCard removes a card's runs with it, so this is unreachable today; if card deletion
    // starts keeping runs (workstream 3b) this must return the run without a card instead.
    if (!card) return { ok: false, code: 'RUN_NOT_FOUND', message: `run not found: ${runId}` };

    const gates = this.sql
      .exec(
        `SELECT * FROM gates WHERE card_id = ? AND (run_id = ? OR (run_id IS NULL AND (stage_key = ? OR return_stage_key = ?)))
         ORDER BY created_at ASC, rowid ASC`,
        cardId,
        runId,
        row.stage_key as string,
        row.stage_key as string,
      )
      .toArray()
      .map((g) => ({
        id: g.id as string,
        run_id: (g.run_id as string | null) ?? null,
        stage_key: g.stage_key as string,
        status: g.status as RunEvidenceGate['status'],
        decision: g.decision ? (EVIDENCE_DECISION[g.decision as string] ?? null) : null,
        decided_by: (g.decided_by as string | null) ?? null,
        produced_by: g.produced_by as string,
        // Not resolved here: the Durable Object has no catalog. The Worker fills these in.
        produced_by_principal_id: null,
        decided_by_principal_id: null,
        decided_by_hub_sub: null,
        created_at: g.created_at as string,
        resolved_at: (g.resolved_at as string | null) ?? null,
      }));

    const u = this.sql
      .exec(
        `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o,
                COALESCE(SUM(cost_usd), 0) AS c
           FROM usage_records WHERE run_id = ?`,
        runId,
      )
      .toArray()[0]!;
    const usage: RunEvidence['usage'] =
      Number(u.n) > 0
        ? { status: 'reported', input_tokens: Number(u.i), output_tokens: Number(u.o), cost_usd: Number(u.c) }
        : { status: 'unreported', input_tokens: null, output_tokens: null, cost_usd: null };

    return {
      ok: true,
      value: {
        run: {
          id: row.id as string,
          board_id: boardId,
          card_id: cardId,
          stage_key: row.stage_key as string,
          agent_id: row.agent_id as string,
          agent_principal_id: null,
          status: row.status as string,
          outcome: (row.outcome as string | null) ?? null,
          started_at: row.started_at as string,
          ended_at: (row.ended_at as string | null) ?? null,
        },
        card: { id: card.id, title: card.title, stage_key: card.currentStageKey },
        gates,
        usage,
        as_of: this.now(),
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
          handoff: r.handoff_json ? (JSON.parse(r.handoff_json as string) as JsonValue) : null,
          failureReason: (r.failure_reason as string | null) ?? null,
          /**
           * Why this run ended as it did, when a stage asked for something.
           *
           * Carried so a reader does not have to infer intent from an outcome. A published
           * receipt once recorded `publish · completed` for a run that had refused, and the only
           * fix available was a prose caveat explaining that a repeated stage usually means the
           * earlier one did nothing. This is that caveat replaced by the fact.
           */
          completion: r.completion ? (JSON.parse(r.completion as string) as Record<string, unknown>) : null,
        };
      });
  }

  // ----- RPC: agent contract (docs/04) -----

  /**
   * The suite principal id this local agent maps to (`agents.external_id`), or `null` if it has
   * never been linked to one. A grant enumerates principal ids
   * (charter decisions/2026-08-30-an-agent-is-a-principal.md §3/§5), not superpipeline's local
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
   * when the auth path that authenticated this request already fetched it — a `spa_` token does,
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
    const max = input.maxConcurrency === undefined ? 1 : input.maxConcurrency;
    // RPC types do not validate runtime values. Invalid limits must never admit work.
    if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) return { claimed: false };
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
        `SELECT * FROM cards c WHERE ${this.claimableWhere(placeholders)}
         ORDER BY c.priority DESC, (c.due_at IS NULL), c.due_at ASC, c.created_at ASC LIMIT 1`,
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
        // Parked without ending a run — there is no run; this stops a dispatch rather
        // than finishing one, which is why the run is left named.
        // `row.id`: this runs inside the claim loop, where the candidate card is the row
        // in hand and there is no `cardId` in scope. Parked without releasing a run
        // because there is no run — this stops a dispatch rather than ending one.
        this.parkForHuman(row.id as string, { reason: 'not-authorised', detail: why }, false);
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
    this.reportRun(runId);
    this.emit('card.claimed', { cardId: card.id, agentId: input.agentId, runId });
    await this.scheduleReclaim();

    const stage = this.stages().find((s) => s.key === card.currentStageKey)!;
    const handoff = row.handoff_json ? (JSON.parse(row.handoff_json as string) as JsonValue) : null;
    return {
      claimed: true,
      runId,
      leaseEpoch,
      card: this.mustGetCard(card.id),
      stage,
      handoff,
      lastFailure: this.lastFailureAt(card.id, stage.key, runId),
    };
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
      this.reportRun(input.runId);
    }
    this.emit('activity', { runId: input.runId, cardId, activityType: input.type });
    await this.scheduleReclaim();
    return { ok: true, value: { accepted: true, cardState } };
  }

  /**
   * Finish a turn on a card, and say what kind of finish it is (`StageOutcome`).
   *
   * `pass` (or nothing, on a stage that judges nothing) stores the handoff and advances the card —
   * what this always did. `changes-needed` sends it BACK to the stage's `returnStage` with the
   * findings, bounded by `MAX_AUTOMATIC_RETURNS`. `needs-person` parks it on a question and is
   * handled before anything here treats the run as finished: see `waitOnPerson`.
   */
  async complete(input: CompleteVerbInput): Promise<Result<CardView>> {
    const auth = this.authorizeRun(input);
    if (!auth.ok) return auth;
    const run = auth.run;
    const cardId = run.card_id as string;
    // Refused BEFORE the run ends, so a malformed call is something the agent corrects on the same
    // run rather than a card the board has to reason about. The REST surface casts rather than
    // parses, so the vocabulary is checked here too.
    if (input.outcome !== undefined && !OUTCOMES.has(input.outcome)) {
      return { ok: false, code: 'INVALID_OUTCOME', message: `outcome must be one of ${[...OUTCOMES].join(', ')}` };
    }
    const outcomeError = outcomeInputError(input);
    if (outcomeError) return { ok: false, code: 'INVALID_OUTCOME', message: outcomeError };
    if (input.findings !== undefined && new TextEncoder().encode(input.findings).length > COMMENT_MAX_BYTES) {
      return { ok: false, code: 'INVALID_OUTCOME', message: `findings are at most ${COMMENT_MAX_BYTES} bytes — link anything longer` };
    }
    if (input.outcome === 'needs-person') return this.waitOnPerson(input, run);

    const card = this.mustGetCard(cardId);
    const stages = this.stages();
    const stageIndex = stages.findIndex((stage) => stage.key === card.currentStageKey);
    const nextStage = stageIndex === -1 ? undefined : stages[stageIndex + 1];
    let approvalSubject: PreparedApprovalSubject | null = null;
    if (nextStage?.approvalSubjectSchema && nextStage.gate === 'approval' && !this.isAgentClaimable(nextStage)) {
      const prepared = await this.prepareApprovalSubject(card, nextStage, input.handoff, input.runId, run.agent_id as string);
      if (!prepared.ok) return prepared;
      approvalSubject = prepared.value;

      // SHA-256 is asynchronous. A Durable Object may admit another request while it is awaited,
      // so fence again before the first write. The winning completion ends the run synchronously;
      // every concurrent completion then observes a stale lease instead of colliding mid-transaction.
      const fenced = this.authorizeRun(input);
      if (!fenced.ok) return fenced;
      const current = this.getCard(cardId);
      if (!current || current.currentStageKey !== card.currentStageKey || (fenced.run.card_id as string) !== cardId) {
        return { ok: false, code: 'STALE_LEASE', message: 'the card moved while the approval subject was prepared' };
      }
    }
    const now = this.now();
    // Computed here rather than further down, because the run's own record needs it too. Same
    // expression the card gets below; `undefined` (no handoff given) stays NULL in both.
    const handoffJson = input.handoff !== undefined ? JSON.stringify(input.handoff) : null;
    // The handoff lands on the RUN as well as the card: the card's copy is what the next claim
    // reads and is overwritten at every stage; this one is the permanent record of what this stage
    // said when it finished.
    const endRun = () => {
      this.sql.exec(
        `UPDATE runs SET status = 'ended', outcome = 'completed', ended_at = ?, handoff_json = ? WHERE id = ?`,
        now,
        handoffJson,
        input.runId,
      );
      this.cancelElicitationsForRun(input.runId);
    };
    // A digest-bound completion commits its run/card/subject/gate binding together below. Generic
    // completions retain their established order and behaviour.
    if (!approvalSubject) endRun();

    /**
     * Completion is earned, not announced.
     *
     * This method wrote `outcome = 'completed'` and advanced the card unconditionally, so an agent
     * calling `complete` was the sole author of the claim that its stage was done — and on the
     * Press board that claim was false twice, once over a commit sitting unpushed on a station and
     * once for a run that had explicitly refused to publish.
     *
     * A card may override its stage (D3). The override REPLACES rather than merges: a card saying
     * `{}` means "this card's stage rule does not apply here", and a merge would make that
     * impossible to say. It is recorded on the run, because routing around a check is a legitimate
     * act and a silent one is not.
     */
    const stage = stages.find((st) => st.key === card.currentStageKey);
    const cardOverride = (card.spec as { completion?: CompletionRequirement } | null | undefined)?.completion;
    const requirement = cardOverride ?? stage?.completion;
    let approvalCompletionRecord: Record<string, unknown> | null = null;

    const returnsSoFar = Number(this.getCardRow(cardId)?.auto_returns ?? 0);
    const route = routeOutcome(
      { key: card.currentStageKey, ...(stage?.returnStage ? { returnStage: stage.returnStage } : {}) },
      input,
      { returnsSoFar, limit: MAX_AUTOMATIC_RETURNS },
    );

    const refusals: string[] = [];
    let verdict: ReturnType<typeof evaluateCompletion> | null = null;
    if (requirement) {
      verdict = evaluateCompletion(requirement, {
        handoff: input.handoff,
        references: this.sql
          .exec(`SELECT provider, source_type AS sourceType FROM card_references WHERE card_id = ?`, cardId)
          .toArray()
          .map((r) => ({ provider: r.provider as string, sourceType: r.sourceType as string })),
      });
      if (!verdict.met) refusals.push(verdict.reason ?? 'the completion requirement was not met');
    }
    // A judging stage that said nothing has not said it passed. Same path as a missing handoff key:
    // one automatic rework naming what to add, then a person.
    if (route.kind === 'refuse') refusals.push(route.reason);

    const completionRecord =
      requirement || input.outcome !== undefined || refusals.length > 0
        ? {
        ...(verdict ?? { met: refusals.length === 0 }),
        ...(refusals.length > 0 ? { met: false, reason: refusals.join('; ') } : {}),
        ...(requirement ? { override: cardOverride !== undefined } : {}),
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
          }
        : null;
    if (completionRecord) {
      if (approvalSubject && refusals.length === 0 && route.kind === 'advance') {
        approvalCompletionRecord = completionRecord;
      } else {
        this.recordRunCompletion(input.runId, completionRecord);
      }
    }

    if (refusals.length > 0) {
      if (approvalSubject) endRun();
      const why = refusals.join('; ');
      // Blocked, not failed (D1): the agent asserted something untrue. The run says so whatever
      // happens to the card next.
      this.sql.exec(`UPDATE runs SET outcome = 'blocked' WHERE id = ?`, input.runId);
      const reason = `this stage was not finished: ${why}`;
      this.reworkOrPark(cardId, card.currentStageKey, input.runId, why, input.handoff);
      // On the card's own replay, as an `error`: a refusal a reader has to reconstruct from
      // run outcomes is a refusal most readers will miss.
      this.sql.exec(
        `INSERT INTO activities (run_id, card_id, type, ephemeral, body, action, detail_json, ts)
         VALUES (?, ?, 'error', 0, ?, NULL, ?, ?)`,
        input.runId,
        cardId,
        reason,
        JSON.stringify({
          parameter: requirement ?? { returnStage: stage?.returnStage ?? null },
          result: verdict ?? { met: false, reason: why },
          signal: null,
        }),
        now,
      );
      this.reportRun(input.runId);
      await this.scheduleReclaim();
      return { ok: true, value: this.mustGetCard(cardId) };
    }

    if (route.kind === 'return' || route.kind === 'park') {
      if (approvalSubject) endRun();
      const findings = input.findings!.trim();
      // The findings go on the thread, where people read, as the judge's own words.
      this.writeComment(cardId, { kind: 'agent', id: run.agent_id as string, name: null }, findings);
      // A return stage written before validation existed, or left dangling by a board created with
      // one, is a return nobody can follow: the card stops for a person rather than going nowhere.
      const broken = route.kind === 'return' && stage ? returnStageError(stage, stages) : null;
      if (route.kind === 'return' && !broken) {
        this.returnCard(cardId, card.currentStageKey, route.to, input.runId, findings, input.handoff, returnsSoFar + 1);
      } else {
        const why = broken ?? (route.kind === 'park' ? route.reason : '');
        const detail = `${why}. Findings: ${findings}`;
        const repeated = route.kind === 'park' && route.repeated;
        this.parkForHuman(
          cardId,
          repeated ? { reason: 'repeated-failure', failureCount: returnsSoFar + 1, detail } : { reason: 'blocked', detail },
        );
        this.emit('card.blocked', { cardId, reason: detail, ...(repeated ? { brokeCircuit: true } : {}) });
        this.notify(repeated ? 'failed' : 'blocked', cardId, detail);
      }
      this.reportRun(input.runId);
      await this.scheduleReclaim();
      return { ok: true, value: this.mustGetCard(cardId) };
    }

    if (approvalSubject) {
      this.ctx.storage.transactionSync(() => {
        endRun();
        if (approvalCompletionRecord) this.recordRunCompletion(input.runId, approvalCompletionRecord);
        this.advanceCard(cardId, card.currentStageKey, run.agent_id as string, handoffJson, input.runId, approvalSubject);
      });
    } else {
      this.advanceCard(cardId, card.currentStageKey, run.agent_id as string, handoffJson, input.runId, null);
    }
    // After advanceCard: a human gate it opened judges this run, so the run reports `waiting`.
    this.reportRun(input.runId);
    await this.scheduleReclaim();
    return { ok: true, value: this.mustGetCard(cardId) };
  }

  /**
   * Send a card back to an earlier stage on a judge's `changes-needed`.
   *
   * The handoff the fixer receives is the judge's own, with the findings lifted into `feedback` —
   * the key a reviewer's request-changes already uses and AgentPod's card prompt renders as its own
   * section — and kept verbatim in `findings` beside `returnedFrom`. The return is a fresh visit to
   * the target stage, so the breaker count starts over there; `auto_returns` is what bounds the loop.
   */
  private returnCard(
    cardId: string,
    fromStageKey: string,
    toStageKey: string,
    runId: string,
    findings: string,
    judgeHandoff: JsonValue | undefined,
    returns: number,
  ): void {
    const carried = {
      feedback: `Sent back from "${fromStageKey}": changes are needed.\n\n${findings}`,
      findings,
      returnedFrom: fromStageKey,
    };
    const merged =
      judgeHandoff && typeof judgeHandoff === 'object' && !Array.isArray(judgeHandoff)
        ? { ...judgeHandoff, ...carried }
        : { ...carried, ...(judgeHandoff !== undefined ? { judgeHandoff } : {}) };
    this.sql.exec(
      `UPDATE cards SET current_stage_key = ?, state = 'submitted', delegate_agent_id = NULL, current_run_id = NULL,
              failure_count = 0, needs_human_json = NULL, handoff_json = ?, auto_returns = ?, updated_at = ? WHERE id = ?`,
      toStageKey,
      JSON.stringify(merged),
      returns,
      this.now(),
      cardId,
    );
    this.emit('card.returned', { cardId, from: fromStageKey, to: toStageKey, runId, returns });
    this.notify('rework', cardId, `Sent back to "${toStageKey}" from "${fromStageKey}": ${findings}`);
    this.notifyWorkAvailable(cardId);
  }

  /**
   * Park a card on a person, at the agent's request: `complete` with `outcome: 'needs-person'`.
   *
   * An agent that needed a person to approve a device sign-in ended its turn with the link, and the
   * board read that as a finished handoff missing a field — refused it, reworked it, refused it
   * again and parked the card as a broken handoff. Nothing was broken; the agent had no way to say
   * "I am waiting on somebody" that ended its turn.
   *
   * This is that way, and it is the existing question, not a new kind of wait: an `elicitation`
   * row, so the question shows in Needs you, on the card, and in the board's chat room exactly as
   * a live run's question does. What differs is that the run ENDS — the harness has stopped, and a
   * lease nobody heartbeats would be reclaimed as a crash. Answering it (`answerElicitation`)
   * re-queues the same stage with the answer and this run's handoff as the work so far.
   *
   * Not a failure and not a refusal: `failure_count` and the stage's one automatic rework are both
   * untouched, and the completion requirement is not evaluated — nothing was claimed finished. The
   * run's outcome is `blocked`, the word the bridge already reads as "the agent reported for itself".
   */
  private async waitOnPerson(input: CompleteVerbInput, run: Row): Promise<Result<CardView>> {
    const cardId = run.card_id as string;
    const now = this.now();
    const handoffJson = input.handoff !== undefined ? JSON.stringify(input.handoff) : null;
    this.sql.exec(
      `UPDATE runs SET status = 'ended', outcome = 'blocked', ended_at = ?, handoff_json = ? WHERE id = ?`,
      now,
      handoffJson,
      input.runId,
    );
    this.cancelElicitationsForRun(input.runId);
    const url = input.url?.trim();
    const question = url ? `${input.question!.trim()}\n\n${url}` : input.question!.trim();
    const asked: AgentActivityInput = {
      runId: input.runId,
      leaseEpoch: input.leaseEpoch,
      agentId: input.agentId,
      type: 'elicitation',
      body: question,
      parameter: input.options !== undefined ? ({ options: input.options } as JsonValue) : null,
    };
    // On the replay as the question it is, like a live run's.
    this.sql.exec(
      `INSERT INTO activities (run_id, card_id, type, ephemeral, body, action, detail_json, ts)
       VALUES (?, ?, 'elicitation', 0, ?, NULL, ?, ?)`,
      input.runId,
      cardId,
      question,
      JSON.stringify({ parameter: asked.parameter ?? null, result: url ? { url } : null, signal: null }),
      now,
    );
    this.openElicitation(asked, run, cardId, now);
    this.sql.exec(
      `UPDATE cards SET state = 'input-required', delegate_agent_id = NULL, current_run_id = NULL, updated_at = ? WHERE id = ?`,
      now,
      cardId,
    );
    this.emit('card.waiting_on_person', { cardId, runId: input.runId });
    this.reportRun(input.runId);
    await this.scheduleReclaim();
    return { ok: true, value: this.mustGetCard(cardId) };
  }

  /** The verdict, on the run, so the trace and the receipt can read it rather than infer it. */
  private recordRunCompletion(runId: string, verdict: Record<string, unknown>): void {
    this.sql.exec(`UPDATE runs SET completion = ? WHERE id = ?`, JSON.stringify(verdict), runId);
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
    // Waiting to be looked at, which is a different thing from being stuck — and the
    // only one of the five that is a healthy, expected place for a card to rest.
    this.parkForHuman(cardId, { reason: 'review' });
    const card = this.mustGetCard(cardId);
    this.sql.exec(
      `UPDATE cards SET state = 'input-required', delegate_agent_id = NULL, current_run_id = NULL, updated_at = ? WHERE id = ?`,
      now,
      cardId,
    );
    // request_changes returns to the same (worked) stage so the agent can redo it.
    this.createGate(cardId, card.currentStageKey, card.currentStageKey, run.agent_id as string, input.runId);
    this.reportRun(input.runId);
    await this.scheduleReclaim();
    return { ok: true, value: this.mustGetCard(cardId) };
  }

  /** Resolve a pending approval gate (docs/08 §6). Enforces separation of duties. */
  async resolveGate(input: {
    gateId: string;
    decision: GateDecision;
    decidedBy: string;
    comment?: string;
    approvalSubjectId?: string;
    approvalSubjectDigest?: string;
  }): Promise<Result<CardView>> {
    const gate = this.sql.exec(`SELECT * FROM gates WHERE id = ?`, input.gateId).toArray()[0];
    if (!gate) return { ok: false, code: 'GATE_NOT_FOUND', message: `gate not found: ${input.gateId}` };
    if ((gate.status as string) !== 'pending') {
      return { ok: false, code: 'GATE_NOT_PENDING', message: 'gate is already resolved' };
    }
    if (input.decidedBy === (gate.produced_by as string)) {
      return { ok: false, code: 'SEPARATION_OF_DUTIES', message: 'the producer cannot resolve their own gate' };
    }

    const boundSubjectId = (gate.approval_subject_id as string | null) ?? null;
    if (boundSubjectId) {
      const deciders = JSON.parse((gate.approval_decider_ids_json as string | null) ?? '[]') as string[];
      if (input.decidedBy.startsWith('agt_') || !deciders.includes(input.decidedBy)) {
        return {
          ok: false,
          code: 'APPROVAL_DECIDER_NOT_ALLOWED',
          message: 'this principal is not an authorized human decider for the approval subject',
        };
      }
      if (
        input.approvalSubjectId !== boundSubjectId ||
        input.approvalSubjectDigest !== (gate.approval_subject_digest as string)
      ) {
        return {
          ok: false,
          code: 'APPROVAL_SUBJECT_MISMATCH',
          message: 'the rendered approval subject id and digest no longer match this gate',
        };
      }
      const subject = this.sql.exec(`SELECT status, digest FROM approval_subjects WHERE id = ?`, boundSubjectId).toArray()[0];
      if (
        !subject ||
        subject.status !== 'active' ||
        subject.digest !== gate.approval_subject_digest ||
        this.getCardRow(gate.card_id as string)?.active_approval_subject_id !== boundSubjectId
      ) {
        return { ok: false, code: 'APPROVAL_SUBJECT_MISMATCH', message: 'the approval subject is no longer active' };
      }
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
    if (boundSubjectId && (input.decision === 'approve_manual' || input.decision === 'approve_automatic')) {
      this.sql.exec(
        `INSERT INTO approval_delivery_events
           (id, gate_id, subject_id, event, from_mode, to_mode, actor, live_url, created_at)
         VALUES (?, ?, ?, 'approved', NULL, ?, ?, NULL, ?)`,
        newId('ade'),
        input.gateId,
        boundSubjectId,
        input.decision === 'approve_manual' ? 'manual' : 'automatic',
        input.decidedBy,
        now,
      );
    }
    if (input.decision === 'approve_manual' && boundSubjectId) {
      // A manual approval remains on its human stage: publisher claims are impossible by routing,
      // while verifyApprovalSubject independently fences a corrupted or stale claim.
      this.parkForHuman(cardId, { reason: 'review', detail: 'approved for manual delivery' });
    } else if (isApproveDecision(input.decision)) {
      // The approver becomes the producer of any chained gate (keeps separation-of-duties intact).
      // An approval produces no new work, so a chained gate judges the same run's work.
      this.advanceCard(cardId, gate.stage_key as string, input.decidedBy, this.getCardHandoffJson(cardId), (gate.run_id as string | null) ?? null);
    } else if (input.decision === 'request_changes') {
      if (boundSubjectId) this.invalidateApprovalSubject(cardId, 'gate.request_changes', input.decidedBy);
      // Keep the agent's prior handoff and add the reviewer's feedback so rework has full context.
      const prior = this.parseHandoff(this.getCardHandoffJson(cardId));
      const merged =
        prior && typeof prior === 'object' && !Array.isArray(prior)
          ? { ...prior, feedback: input.comment ?? null }
          : { feedback: input.comment ?? null };
      this.sql.exec(
        `UPDATE cards SET current_stage_key = ?, state = 'submitted', delegate_agent_id = NULL,
         current_run_id = NULL, failure_count = 0, auto_returns = 0, handoff_json = ?, updated_at = ? WHERE id = ?`,
        gate.return_stage_key,
        JSON.stringify(merged),
        now,
        cardId,
      );
      this.emit('card.changes_requested', { cardId, gateId: input.gateId, to: gate.return_stage_key });
      this.notifyWorkAvailable(cardId); // back on a claimable stage for rework
    } else {
      if (boundSubjectId) this.invalidateApprovalSubject(cardId, 'gate.reject', input.decidedBy);
      this.sql.exec(
        `UPDATE cards SET state = 'rejected', delegate_agent_id = NULL, current_run_id = NULL, updated_at = ? WHERE id = ?`,
        now,
        cardId,
      );
      this.emit('card.rejected', { cardId, gateId: input.gateId });
    }
    this.emit('gate.resolved', { gateId: input.gateId, cardId, decision: input.decision, decidedBy: input.decidedBy });
    // After advanceCard: an approval into another human gate stage chains a gate on the same run.
    const judged = this.runJudgedByGate(gate);
    if (judged) this.reportRun(judged);
    await this.scheduleReclaim();
    return { ok: true, value: this.mustGetCard(cardId) };
  }

  /** Change delivery mechanics without changing the approved immutable bytes. */
  async updateApprovalDelivery(input: {
    gateId: string;
    actor: string;
    mode?: 'manual' | 'automatic';
    liveUrl?: string;
  }): Promise<Result<CardView & { delivery: NonNullable<GateView['delivery']> }>> {
    const gate = this.sql.exec(`SELECT * FROM gates WHERE id = ?`, input.gateId).toArray()[0];
    if (!gate) return { ok: false, code: 'GATE_NOT_FOUND', message: `gate not found: ${input.gateId}` };
    const subjectId = (gate.approval_subject_id as string | null) ?? null;
    const decision = gate.decision as string | null;
    if (gate.status !== 'resolved' || !subjectId || (decision !== 'approve_manual' && decision !== 'approve_automatic')) {
      return { ok: false, code: 'APPROVAL_DELIVERY_NOT_AVAILABLE', message: 'this gate has no changeable delivery approval' };
    }
    const deciders = JSON.parse((gate.approval_decider_ids_json as string | null) ?? '[]') as string[];
    if (input.actor.startsWith('agt_') || !deciders.includes(input.actor)) {
      return { ok: false, code: 'APPROVAL_DECIDER_NOT_ALLOWED', message: 'this principal cannot change approval delivery' };
    }
    const cardId = gate.card_id as string;
    const cardRow = this.getCardRow(cardId);
    const subject = this.sql.exec(`SELECT status FROM approval_subjects WHERE id = ?`, subjectId).toArray()[0];
    if (!cardRow || cardRow.active_approval_subject_id !== subjectId || subject?.status !== 'active') {
      return { ok: false, code: 'APPROVAL_SUBJECT_MISMATCH', message: 'the approved subject is no longer active' };
    }
    if ((input.mode === undefined) === (input.liveUrl === undefined)) {
      return { ok: false, code: 'INVALID_APPROVAL_DELIVERY', message: 'provide exactly one of mode or liveUrl' };
    }

    const now = this.now();
    if (input.liveUrl !== undefined) {
      if (decision !== 'approve_manual') {
        return { ok: false, code: 'APPROVAL_DELIVERY_NOT_MANUAL', message: 'a live URL is recorded only for manual delivery' };
      }
      let parsed: URL;
      try {
        parsed = new URL(input.liveUrl);
      } catch {
        return { ok: false, code: 'INVALID_LIVE_URL', message: 'live URL must be an absolute https URL' };
      }
      if (parsed.protocol !== 'https:') {
        return { ok: false, code: 'INVALID_LIVE_URL', message: 'live URL must be an absolute https URL' };
      }
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `UPDATE gates SET live_post_url = ?, live_post_url_recorded_by = ?, live_post_url_recorded_at = ?,
                            live_post_readback_status = 'not_checked' WHERE id = ?`,
          parsed.toString(),
          input.actor,
          now,
          input.gateId,
        );
        this.sql.exec(
          `INSERT INTO approval_delivery_events
             (id, gate_id, subject_id, event, from_mode, to_mode, actor, live_url, created_at)
           VALUES (?, ?, ?, 'live_url_recorded', 'manual', 'manual', ?, ?, ?)`,
          newId('ade'),
          input.gateId,
          subjectId,
          input.actor,
          parsed.toString(),
          now,
        );
      });
    } else {
      const currentMode = decision === 'approve_manual' ? 'manual' : 'automatic';
      const nextMode = input.mode!;
      if (nextMode !== currentMode) {
        if (currentMode === 'automatic') {
          if (cardRow.current_run_id || cardRow.state === 'working') {
            return { ok: false, code: 'APPROVAL_DELIVERY_STARTED', message: 'automatic delivery has already been claimed' };
          }
          this.sql.exec(
            `UPDATE cards SET current_stage_key = ?, state = 'input-required', delegate_agent_id = NULL,
                              current_run_id = NULL, needs_human_json = ?, updated_at = ? WHERE id = ?`,
            gate.stage_key,
            JSON.stringify({ reason: 'review', detail: 'approved for manual delivery' }),
            now,
            cardId,
          );
        } else {
          if (gate.live_post_url) {
            return { ok: false, code: 'APPROVAL_DELIVERY_STARTED', message: 'manual delivery already has a recorded live URL' };
          }
          this.setNeedsHuman(cardId, null);
          this.advanceCard(cardId, gate.stage_key as string, input.actor, this.getCardHandoffJson(cardId), (gate.run_id as string | null) ?? null);
        }
        this.sql.exec(`UPDATE gates SET decision = ? WHERE id = ?`, nextMode === 'manual' ? 'approve_manual' : 'approve_automatic', input.gateId);
        this.sql.exec(
          `INSERT INTO approval_delivery_events
             (id, gate_id, subject_id, event, from_mode, to_mode, actor, live_url, created_at)
           VALUES (?, ?, ?, 'mode_switched', ?, ?, ?, NULL, ?)`,
          newId('ade'),
          input.gateId,
          subjectId,
          currentMode,
          nextMode,
          input.actor,
          now,
        );
      }
    }

    const view = this.rowToGate(this.getGateRow(input.gateId)!);
    return { ok: true, value: { ...this.mustGetCard(cardId), delivery: view.delivery! } };
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

    // A question an agent parked the card on (`complete` with `needs-person`) has no live run to
    // carry the answer back to: the card resumes by being worked again, at the same stage.
    const asker = this.sql.exec(`SELECT status, handoff_json FROM runs WHERE id = ?`, elicitation.runId).toArray()[0];
    if (asker && (asker.status as string) === 'ended') {
      if (card.state !== 'input-required' || card.currentStageKey !== elicitation.stageKey) {
        return { ok: false, code: 'CARD_NOT_WAITING', message: `a card in "${card.state}" is not waiting on an answer` };
      }
      return this.resumeParkedQuestion(elicitation, card, { option, text, answeredBy: input.answeredBy }, (asker.handoff_json as string | null) ?? null);
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
    // Answered: the card is not waiting on anybody any more.
    this.setNeedsHuman(card.id, null);

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
    this.reportRun(elicitation.runId);
    await this.scheduleReclaim();
    return {
      ok: true,
      value: { card: this.mustGetCard(card.id), elicitation: this.mustGetElicitation(elicitation.id) },
    };
  }

  /**
   * Answer a question an agent parked its card on, and put the card back to work.
   *
   * The asking run has ended, so the answer cannot be "collected" the way a live run collects one.
   * Instead the card returns to `submitted` on the SAME stage, and the next claim is handed:
   *  - the stage's own input, unchanged — the work continues, it does not start from nothing;
   *  - `feedback` saying what was asked and what the person answered (the key AgentPod's card
   *    prompt lifts into its own section), keeping any earlier feedback beneath it;
   *  - `resumed`: the question, the answer, and the parked run's handoff as `workSoFar`.
   *
   * No failure is counted and the stage's automatic rework is not spent: a pause is not a fault.
   */
  private async resumeParkedQuestion(
    elicitation: ElicitationView,
    card: CardView,
    answer: { option: string; text: string; answeredBy: string },
    parkedHandoffJson: string | null,
  ): Promise<Result<{ card: CardView; elicitation: ElicitationView }>> {
    const now = this.now();
    const option = answer.option === '' ? null : answer.option;
    const text = answer.text === '' ? null : answer.text;
    this.sql.exec(
      `UPDATE elicitations SET status = 'answered', answer_option = ?, answer_text = ?, answered_by = ?, answered_at = ? WHERE id = ?`,
      option,
      text,
      answer.answeredBy,
      now,
      elicitation.id,
    );
    const chosen = elicitation.options.find((o) => o.name === option);
    const said = [chosen?.title ?? option ?? '', text ?? ''].filter((s) => s !== '').join(' — ');

    const prior = this.parseHandoff(this.getCardHandoffJson(card.id));
    const base = prior && typeof prior === 'object' && !Array.isArray(prior) ? (prior as Record<string, JsonValue>) : {};
    const earlier = typeof base.feedback === 'string' && base.feedback.trim() !== '' ? `\n\nEarlier feedback, still standing:\n${base.feedback}` : '';
    const merged = {
      ...base,
      feedback:
        `You stopped to ask a person:\n${elicitation.question}\n\nThey answered: ${said}\n\n` +
        `Continue the same work from where you left off.${earlier}`,
      resumed: {
        question: elicitation.question,
        answer: { option, text },
        answeredBy: answer.answeredBy,
        workSoFar: this.parseHandoff(parkedHandoffJson),
      },
    };
    this.sql.exec(
      `UPDATE cards SET state = 'submitted', delegate_agent_id = NULL, current_run_id = NULL, needs_human_json = NULL,
              handoff_json = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(merged),
      now,
      card.id,
    );
    this.sql.exec(
      `INSERT INTO activities (run_id, card_id, type, ephemeral, body, action, detail_json, ts)
       VALUES (?, ?, 'prompt', 0, ?, NULL, ?, ?)`,
      elicitation.runId,
      card.id,
      said,
      JSON.stringify({ parameter: { elicitationId: elicitation.id, option }, result: null, signal: null }),
      now,
    );
    this.emit('elicitation.answered', {
      elicitationId: elicitation.id,
      cardId: card.id,
      runId: elicitation.runId,
      option,
      answeredBy: answer.answeredBy,
    });
    this.notifyWorkAvailable(card.id);
    this.reportRun(elicitation.runId);
    await this.scheduleReclaim();
    return { ok: true, value: { card: this.mustGetCard(card.id), elicitation: this.mustGetElicitation(elicitation.id) } };
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
    // The block is the reason now, and it REPLACES any question this run asked — those
    // were just cancelled, and a card pointing at a cancelled question sends somebody
    // to something that no longer exists.
    this.parkForHuman(cardId, { reason: 'blocked', detail: input.reason });
    this.sql.exec(
      `UPDATE cards SET state = 'input-required', delegate_agent_id = NULL, current_run_id = NULL, updated_at = ? WHERE id = ?`,
      now,
      cardId,
    );
    this.emit('card.blocked', { cardId, reason: input.reason });
    this.reportRun(input.runId);
    await this.scheduleReclaim();
    return { ok: true, value: this.mustGetCard(cardId) };
  }

  /** Report a failure — retryable until the circuit breaker trips (docs/08 §4). */
  async fail(input: RunVerbInput & { reason: string }): Promise<Result<CardView>> {
    const auth = this.authorizeRun(input);
    if (!auth.ok) return auth;
    const run = auth.run;
    const cardId = run.card_id as string;
    // The reason, on the run. `outcome = 'crashed'` is a label; the next agent at this stage needs
    // the sentence, and `claim()` reads it from here.
    this.sql.exec(
      `UPDATE runs SET status = 'ended', outcome = 'crashed', ended_at = ?, failure_reason = ? WHERE id = ?`,
      this.now(),
      input.reason || null,
      input.runId,
    );
    this.cancelElicitationsForRun(input.runId);
    this.endAttempt(cardId, 'card.failed', input.reason);
    this.notify('failed', cardId, input.reason || 'Run failed');
    this.reportRun(input.runId);
    // Re-arm: the report just queued needs the alarm, and fail() never re-armed it before.
    await this.scheduleReclaim();
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
    this.reportRun(input.runId);
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
      this.reportRun(r.id as string);
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
    // Its own try/catch: a reporter failure must not stop the alarm re-arming below.
    try {
      await this.drainRunReports();
    } catch (err) {
      logReporter('error', { msg: 'superwitness.drain_failed', 'board.id': this.getMeta('boardId') ?? '', code: err instanceof Error ? err.name : 'unknown' });
    }
    await this.scheduleReclaim();
  }

  // ----- internals -----

  /**
   * Record, or clear, why a card is waiting on a person.
   *
   * One writer so the field cannot drift out of step with the state that implies it.
   * Clearing is the common case and happens wherever a card stops waiting — answered,
   * moved, claimed — because a stale "needs you" is worse than none: it sends somebody
   * to a card that wants nothing.
   */
  private setNeedsHuman(cardId: string, needs: CardNeedsHuman | null): void {
    this.sql.exec(
      `UPDATE cards SET needs_human_json = ? WHERE id = ?`,
      needs ? JSON.stringify(needs) : null,
      cardId,
    );
  }

  /**
   * Bring a card to rest on a person, saying why in the same write.
   *
   * The state and the reason are set together so they cannot drift: a card parked
   * without a reason is the bug this exists to prevent, and leaving the two as separate
   * statements is how that happened the first time.
   *
   * `releaseRun` for the cases where the run is over (blocked, submitted, refused) and
   * false where the card is parked with its run still named — the control-pair refusal,
   * which stops a dispatch rather than ending one.
   */
  private parkForHuman(cardId: string, needs: CardNeedsHuman, releaseRun = true): void {
    this.sql.exec(
      releaseRun
        ? `UPDATE cards SET state = 'input-required', needs_human_json = ?, delegate_agent_id = NULL,
             current_run_id = NULL, updated_at = ? WHERE id = ?`
        : `UPDATE cards SET state = 'input-required', needs_human_json = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(needs),
      this.now(),
      cardId,
    );
  }

  /**
   * A run's handoff failed its stage's completion requirement: rework once, then park.
   *
   * The first refusal on a visit to a stage sends the card straight back to `submitted` on the same
   * stage, with feedback naming exactly what was missing — written into the handoff the next claim
   * and the run context carry, which is the path a reviewer's "request changes" already uses. The
   * board's input to the stage is kept, so the rework still has its brief.
   *
   * Three things bound it, so it cannot loop:
   *  - one rework per visit (`completion_rework_json`): a second refusal parks the card `blocked`,
   *    naming both refusals, because by then the agent has been told once and a third try is
   *    budget spent re-asserting the same thing — the reason D1 refused to retry at all;
   *  - the rework is an attempt (`failure_count`), so the circuit breaker still counts it: a refusal
   *    after a crash, or a crash after a rework, trips the breaker exactly as two crashes would;
   *  - only a person resets either — `resumeCard`, or a reviewer's request-changes, which moves
   *    the card through a review stage and so starts a new visit.
   */
  private reworkOrPark(cardId: string, stageKey: string, runId: string, reason: string, refusedHandoff: JsonValue | undefined): void {
    const row = this.getCardRow(cardId);
    if (!row) return;
    const spent = row.completion_rework_json
      ? (JSON.parse(row.completion_rework_json as string) as { stageKey: string; reason: string; runId: string })
      : null;
    const failures = Number(row.failure_count) + 1;
    this.sql.exec(`UPDATE cards SET failure_count = ? WHERE id = ?`, failures, cardId);

    if (spent && spent.stageKey === stageKey) {
      const detail = `this stage was not finished twice — first: ${spent.reason}; then, after one automatic rework: ${reason}`;
      this.parkForHuman(cardId, { reason: 'blocked', detail });
      this.emit('card.blocked', { cardId, reason: detail });
      this.notify('blocked', cardId, detail);
      return;
    }
    if (failures >= CIRCUIT_BREAKER_LIMIT) {
      const detail = `this stage was not finished: ${reason}`;
      this.parkForHuman(cardId, { reason: 'repeated-failure', failureCount: failures, detail });
      this.emit('card.blocked', { cardId, reason: detail, failures, brokeCircuit: true });
      this.notify('failed', cardId, detail);
      return;
    }

    const prior = this.parseHandoff((row.handoff_json as string | null) ?? null);
    const feedback = `Your handoff was refused: ${reason}. Finish this stage again and include what is missing.`;
    const carried = { feedback, refusedHandoff: refusedHandoff ?? null };
    const merged = prior && typeof prior === 'object' && !Array.isArray(prior) ? { ...prior, ...carried } : carried;
    this.sql.exec(
      `UPDATE cards SET state = 'submitted', delegate_agent_id = NULL, current_run_id = NULL, needs_human_json = NULL,
              handoff_json = ?, completion_rework_json = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(merged),
      JSON.stringify({ stageKey, reason, runId }),
      this.now(),
      cardId,
    );
    this.emit('card.rework_requested', { cardId, stageKey, runId, reason, failures });
    this.notify('rework', cardId, `Sent back for one automatic rework: ${reason}`);
    this.notifyWorkAvailable(cardId);
  }

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
    // The breaker is the only thing here that makes a card wait on a person. Below it
    // the card is simply queued again, and any earlier reason — a question this run
    // asked and never got answered — is no longer the thing to look at.
    this.setNeedsHuman(
      cardId,
      state === 'input-required'
        ? { reason: 'repeated-failure', failureCount: failures, ...(reason ? { detail: reason } : {}) }
        : null,
    );
    this.emit(event, { cardId, runId: runId ?? null, reason, failures, brokeCircuit: state === 'input-required' });
    // Central re-queue point (fail + reclaim): a card returned to the queue is claimable again.
    this.notifyWorkAvailable(cardId);
  }

  /**
   * Advance a card to the next stage — opening an approval gate on entry to a human review stage.
   *
   * Called after a run's side effects are already committed (`complete()`'s SQL has run,
   * `resolveGate()`'s approval is recorded), so this method is `void`: by the time it runs there is
   * nothing left to refuse *into*. What it CAN still refuse is the advance itself.
   *
   * A card with open children (the `parent` edge) cannot advance — on the LAST stage this would
   * otherwise write `state = 'completed'` outright, resolving the card while its subtree is still
   * open: anything this card blocks would unblock, and a parent with half-finished children would
   * read as "done" (Task 14 step 3, promoted by Task 13's review — Task 13 guarded `moveCard`, the
   * human path, but left this one, the agent path, open). The fix is a DEFERRED advance, not a
   * refusal: `complete()`/`resolveGate()` must still succeed — the run has ended, the lease has to
   * release — so what is withheld is only the transition, recorded in `pending_advance_json` and
   * replayed by `resumeDeferredParentAdvance` once the last child resolves. Parking in
   * `submitted`/current-stage was rejected: that would make the card claimable again and hand an
   * agent work already done. Refusing from `complete()` was rejected too: the run would stay open,
   * the lease would heartbeat out, and the card would be reclaimed — the retry hot-loop this phase
   * exists to prevent. So: park `input-required`, in the CURRENT stage (not re-queued into it, and
   * not advanced) — the one non-claimable state available without adding one to the A2A-aligned
   * `TaskState`. It is not literally true here ("a human must act"); `openChildCount > 0` is what a
   * reader (Task 17's UI) uses to tell this park apart from a real review gate.
   */
  private advanceCard(
    cardId: string,
    fromStageKey: string,
    producedBy: string,
    handoffJson: string | null,
    runId: string | null,
    approvalSubject: PreparedApprovalSubject | null = null,
  ): void {
    const openChildren = this.openChildCount(cardId);
    if (openChildren > 0) {
      this.sql.exec(
        `UPDATE cards SET state = 'input-required', delegate_agent_id = NULL, current_run_id = NULL,
                pending_advance_json = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify({ fromStageKey, producedBy, handoffJson, runId }),
        this.now(),
        cardId,
      );
      this.emit('card.advance_deferred', { cardId, openChildren });
      // A human has no other way to learn this happened: unlike `moveCard`'s `CARD_BLOCKED`
      // refusal (Task 13), nothing here rejects anything the owner did, so there is no error to
      // see. Some open children never resolve on their own (`openChildren`'s own comment) and the
      // recovery is an existing verb, not automatic — so name them, not just the count, or the
      // owner has a parked card and nothing explaining why.
      this.notify(
        'advance-deferred',
        cardId,
        `waiting on ${openChildren} sub-task${openChildren === 1 ? '' : 's'}: ` +
          this.openChildren(cardId)
            .map((c) => `${c.title} (${c.id})`)
            .join(', '),
      );
      return;
    }
    const stages = this.stages();
    const idx = stages.findIndex((s) => s.key === fromStageKey);
    if (idx === -1) return; // unknown stage — never silently advance to stage[0]
    const next = stages[idx + 1];
    const now = this.now();
    if (!next) {
      this.resolveCard(cardId, handoffJson);
      return;
    }
    // Arriving at a last stage nobody can act on IS finishing — see `completesOnArrival`. Checked
    // before the gate branch because a stage cannot be both.
    if (this.completesOnArrival(next)) {
      this.emit('card.advanced', { cardId, from: fromStageKey, to: next.key });
      this.resolveCard(cardId, handoffJson, next.key);
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
    if (gated) this.createGate(cardId, next.key, fromStageKey, producedBy, runId, approvalSubject);
    else this.notifyWorkAvailable(cardId);
  }

  /**
   * `childId` just reached `completed` (the resolution rule — `RESOLVED_SQL` — which today only
   * `completed` reaches; see the note on `resolveGate`'s sibling branch in `advanceCard`). If it has
   * a parent, that parent may now be free of open children — hand off to `resumeParentAdvanceIfFree`
   * to check and, if so, replay the deferred advance.
   */
  private resumeDeferredParentAdvance(childId: string): void {
    const parentId = this.parentIdOf(childId);
    if (parentId) this.resumeParentAdvanceIfFree(parentId);
  }

  /**
   * `parentId` may have just lost its last open child — not only by that child reaching
   * `completed` (`resumeDeferredParentAdvance`, above), but also by the `parent` edge itself being
   * removed: `deleteCard` deletes a child outright, and `removeLink` can un-parent one without
   * touching the card. `openChildCount` is a live join over `card_links`, so it cannot tell a
   * resolved child from a vanished one — which means neither can a park that depends on it. Without
   * this second call site, deleting or un-parenting the LAST open child of a parked parent would
   * silently strand it: `pending_advance_json` would sit there forever with nothing left to ever
   * recheck it.
   *
   * `openChildCount` is RE-CHECKED here, not decremented — so a parent with several children stays
   * parked through every resolution/removal but the last, and fires exactly once. Clearing
   * `pending_advance_json` before calling `advanceCard` (rather than after) means a parent that
   * turns out to have open children again by the time the replay runs — not reachable via either
   * caller today, but defensive against a future one — cannot re-defer onto a stale record.
   *
   * That clear-before-call ordering has a cost: `advanceCard`'s `idx === -1` guard (stored
   * `fromStageKey` not found in the board's current stage list) returns silently, and by then the
   * record is already gone — so if that guard were ever hit here, the parent would be stranded with
   * nothing left to recheck. Not reachable today — `setStages` refuses to remove a stage holding any
   * card, `countInStage` counts every state so a parked card still holds its stage, and nothing ever
   * moves a parked card's `current_stage_key` — but that safety rests on those three facts staying
   * true elsewhere in this file, not on anything local to this method.
   */
  private resumeParentAdvanceIfFree(parentId: string): void {
    const row = this.sql.exec(`SELECT pending_advance_json FROM cards WHERE id = ?`, parentId).toArray()[0];
    const pendingJson = (row?.pending_advance_json as string | null | undefined) ?? null;
    if (!pendingJson) return;
    if (this.openChildCount(parentId) > 0) return; // another child is still open
    const pending = JSON.parse(pendingJson) as { fromStageKey: string; producedBy: string; handoffJson: string | null; runId?: string | null };
    this.sql.exec(`UPDATE cards SET pending_advance_json = NULL WHERE id = ?`, parentId);
    this.advanceCard(parentId, pending.fromStageKey, pending.producedBy, pending.handoffJson, pending.runId ?? null);
    // The replay may open a gate judging the parent's run, which was reported `succeeded` when the
    // advance was deferred — report it again (R5: same synchronous span). Callers arm the drain.
    if (pending.runId) this.reportRun(pending.runId);
  }

  /** Retire the active subject without deleting its immutable audit row. */
  private invalidateApprovalSubject(cardId: string, reason: string, invalidatedBy: string | null): void {
    const cardRow = this.getCardRow(cardId);
    const subjectId = (cardRow?.active_approval_subject_id as string | null | undefined) ?? null;
    if (!subjectId) return;
    const now = this.now();
    this.sql.exec(
      `UPDATE approval_subjects
          SET status = 'invalidated', invalidated_at = ?, invalidated_by = ?, invalidation_reason = ?
        WHERE id = ? AND status = 'active'`,
      now,
      invalidatedBy,
      reason,
      subjectId,
    );
    this.sql.exec(
      `UPDATE gates SET status = 'cancelled', resolved_at = ?
        WHERE approval_subject_id = ? AND status = 'pending'`,
      now,
      subjectId,
    );
    this.sql.exec(`UPDATE cards SET active_approval_subject_id = NULL WHERE id = ?`, cardId);

    const stage = this.stages().find((candidate) => candidate.key === (cardRow?.current_stage_key as string));
    if (stage && this.isAgentClaimable(stage)) {
      // A publisher may already be looking for work. Parking the card prevents a fresh claim; any
      // existing run is fenced again by verifyApprovalSubject before it may cause a side effect.
      this.sql.exec(
        `UPDATE cards SET state = 'input-required', delegate_agent_id = NULL, current_run_id = NULL, updated_at = ? WHERE id = ?`,
        now,
        cardId,
      );
    }
  }

  private async prepareApprovalSubject(
    card: CardView,
    stage: StageDef,
    handoff: JsonValue | undefined,
    runId: string,
    producedBy: string,
  ): Promise<Result<PreparedApprovalSubject>> {
    const invalid = (message: string): Result<PreparedApprovalSubject> => ({
      ok: false,
      code: 'INVALID_APPROVAL_SUBJECT',
      message,
    });
    if (stage.approvalSubjectSchema !== 'social-publish/v1') {
      return invalid(`unsupported approval subject schema: ${stage.approvalSubjectSchema ?? ''}`);
    }
    if (!stage.approvalDeciderPrincipalIds?.length || stage.approvalDeciderPrincipalIds.some((id) => !nonEmptyString(id))) {
      return invalid(`stage "${stage.key}" needs at least one approval decider principal`);
    }
    if (card.projectId === null) return invalid('approval subject card needs a project');
    if (handoff === null || typeof handoff !== 'object' || Array.isArray(handoff)) {
      return invalid('approval subject handoff must be an object');
    }
    const payload = handoff.publicationPayload;
    const payloadError = socialPublishPayloadError(payload);
    if (payloadError) return invalid(payloadError);

    const prior = this.sql
      .exec(
        `SELECT COALESCE(MAX(revision), 0) AS revision FROM approval_subjects WHERE card_id = ? AND schema = ?`,
        card.id,
        stage.approvalSubjectSchema,
      )
      .one();
    const revision = Number(prior.revision) + 1;
    let canonical: string;
    try {
      canonical = canonicalJson({
        ...(payload as Record<string, JsonValue>),
        schema: stage.approvalSubjectSchema,
        cardId: card.id,
        projectId: card.projectId,
        revision,
      });
    } catch (error) {
      return invalid((error as Error).message);
    }
    const canonicalBytes = new TextEncoder().encode(canonical);
    const hash = await crypto.subtle.digest('SHA-256', canonicalBytes);
    const digest = `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    return {
      ok: true,
      value: {
        id: newId('aps'),
        schema: stage.approvalSubjectSchema,
        revision,
        canonicalBytes,
        digest,
        producerRunId: runId,
        producedBy,
        createdAt: this.now(),
      },
    };
  }

  private createGate(
    cardId: string,
    stageKey: string,
    returnStageKey: string,
    producedBy: string,
    runId: string | null,
    approvalSubject: PreparedApprovalSubject | null = null,
  ): string {
    const id = newId('gate');
    const now = this.now();
    const stage = this.stages().find((candidate) => candidate.key === stageKey);
    this.ctx.storage.transactionSync(() => {
      if (approvalSubject) {
        this.sql.exec(
          `INSERT INTO approval_subjects
             (id, card_id, gate_stage_key, schema, revision, canonical_bytes, digest, status,
              producer_run_id, produced_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          approvalSubject.id,
          cardId,
          stageKey,
          approvalSubject.schema,
          approvalSubject.revision,
          approvalSubject.canonicalBytes,
          approvalSubject.digest,
          approvalSubject.producerRunId,
          approvalSubject.producedBy,
          approvalSubject.createdAt,
        );
      }
      this.sql.exec(
        `INSERT INTO gates
           (id, card_id, stage_key, return_stage_key, status, produced_by, options_json, created_at, run_id,
            approval_subject_id, approval_subject_digest, approval_decider_ids_json)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        id,
        cardId,
        stageKey,
        returnStageKey,
        producedBy,
        JSON.stringify(approvalSubject ? APPROVAL_SUBJECT_GATE_OPTIONS : DEFAULT_GATE_OPTIONS),
        now,
        runId,
        approvalSubject?.id ?? null,
        approvalSubject?.digest ?? null,
        approvalSubject ? JSON.stringify(stage?.approvalDeciderPrincipalIds ?? []) : null,
      );
      if (approvalSubject) {
        this.sql.exec(`UPDATE cards SET active_approval_subject_id = ? WHERE id = ?`, approvalSubject.id, cardId);
      }
    });
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
    this.setNeedsHuman(cardId, { reason: 'question', elicitationId: id });
    this.emit('elicitation.opened', { elicitationId: id, cardId, runId: input.runId, signal: input.signal ?? null });
    this.notify('input', cardId, question === '' ? 'An agent is waiting on you' : question);
    this.notifyElicitationPending(id);
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

  /**
   * The rows of every question currently waiting on a human, board-wide, oldest first.
   *
   * One query with two readers, which is why it is rows rather than either shape: the
   * board's own `ElicitationView` for a person looking at the board, and the wire's
   * `ElicitationPendingBody` for a projection somewhere else. A second copy of this
   * `WHERE` would be a second answer to "what is still waiting", and the two would
   * diverge on the day one of them learned about a new status.
   *
   * `rowid` breaks the tie because `created_at` is a formatted timestamp and two
   * questions asked in the same tick would otherwise come back in an arbitrary order.
   */
  private pendingElicitationRows(): Row[] {
    return this.sql
      .exec(`SELECT * FROM elicitations WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC`)
      .toArray() as Row[];
  }

  /** Every question currently waiting on a human, board-wide — the human's view. */
  private pendingElicitations(): ElicitationView[] {
    return this.pendingElicitationRows().map((r) => this.rowToElicitation(r));
  }

  /**
   * The most recent ENDED run at this card and stage, if it failed.
   *
   * "The last attempt" has to mean the last one, so a failure followed by a success reports nothing.
   * Reporting the older failure would have an agent working around a problem already solved.
   *
   * Ordered by `rowid`, not by `started_at`. `started_at` is a formatted timestamp, and two runs at
   * the same stage can carry the SAME one — a fail and an immediate reclaim do, which is precisely
   * the case this function exists for. Ordering on it then picks arbitrarily between them, and the
   * test for "does not resurrect a failure after a success" caught exactly that. `rowid` is
   * insertion order and cannot tie.
   *
   * `excludeRunId` is the run being handed out right now — it exists by the time this is called, and
   * without excluding it a reclaim could read its own row.
   */
  private lastFailureAt(
    cardId: string,
    stageKey: string,
    excludeRunId: string,
  ): { reason: string; agentId: string; stageKey: string; endedAt: string } | null {
    const rows = this.sql
      .exec(
        `SELECT agent_id, outcome, failure_reason, ended_at FROM runs
         WHERE card_id = ? AND stage_key = ? AND id != ? AND ended_at IS NOT NULL
         ORDER BY rowid DESC LIMIT 1`,
        cardId,
        stageKey,
        excludeRunId,
      )
      .toArray();
    const r = rows[0];
    if (!r) return null;
    // A run that ended well reports nothing — and a failed one with no recorded reason reports
    // nothing either, rather than an empty sentence that reads as information.
    const reason = (r.failure_reason as string | null) ?? null;
    if (r.outcome === 'completed' || !reason) return null;
    return {
      reason,
      agentId: r.agent_id as string,
      stageKey,
      endedAt: (r.ended_at as string) ?? '',
    };
  }

  private isAgentClaimable(stage: StageDef): boolean {
    return stage.ownerKind === 'capability' || stage.ownerKind === 'agent';
  }

  /**
   * Is this the last stage, and can anybody act on it?
   *
   * A terminal stage that is human-owned and declares no approval gate is a stage from which a card
   * can never leave. No agent may claim it (`isAgentClaimable` is false for `human`), no gate will
   * ever be created to ask anyone (`advanceCard` only creates one for `gate: 'approval'`), and no
   * route writes card state. Cards reached it and read `submitted` forever — and ALL FOUR shipped
   * templates end in exactly that shape (`shipped`, `published`, `closed`, `ready`), so every board
   * made from one was born unable to express completion.
   *
   * So arriving there IS finishing, and the card is resolved on arrival.
   *
   * Narrow on purpose. The two stages this deliberately excludes are excluded because something can
   * still act, and completing on arrival would destroy that act without a trace:
   *
   *   - a CAPABILITY-owned last stage still has its run to do. Completing on arrival would mean the
   *     final publish or deploy never happens while the board says it did.
   *   - a GATED last stage still has its review. That approval is where a person confirms the work;
   *     deleting it silently is worse than the stall this fixes.
   */
  private completesOnArrival(stage: StageDef): boolean {
    const stages = this.stages();
    if (stages[stages.length - 1]?.key !== stage.key) return false;
    return !this.isAgentClaimable(stage) && stage.gate !== 'approval';
  }

  /**
   * Resolve a card: the ONE place `state = 'completed'` is written.
   *
   * Extracted because the comment that used to live inline asked for exactly this — "any FUTURE
   * path that writes `state = 'completed'` or `'canceled'` to a card needs this same call" — and
   * there are now three such paths (a run ending on the last stage, an agent advancing into a
   * terminal stage nobody can act on, and a human moving a card there). Three copies of the
   * bookkeeping is three chances to forget `notifyDependents`, which is how a blocked card stays
   * blocked after the thing blocking it finished.
   *
   * `stageKey` is passed when the card is being moved into its final stage at the same moment it
   * resolves, so the row never exists in an in-between state a reader could observe.
   */
  private resolveCard(cardId: string, handoffJson: string | null, stageKey?: string): void {
    const now = this.now();
    if (stageKey === undefined) {
      this.sql.exec(
        `UPDATE cards SET state = 'completed', delegate_agent_id = NULL, current_run_id = NULL, failure_count = 0, handoff_json = ?, updated_at = ? WHERE id = ?`,
        handoffJson,
        now,
        cardId,
      );
    } else {
      this.sql.exec(
        `UPDATE cards SET current_stage_key = ?, state = 'completed', delegate_agent_id = NULL, current_run_id = NULL, failure_count = 0, handoff_json = ?, updated_at = ? WHERE id = ?`,
        stageKey,
        handoffJson,
        now,
        cardId,
      );
    }
    this.emit('card.completed', { cardId });
    // This card just became genuinely resolved (Task 13's rule: `completed`/`canceled` only) —
    // anything it held back may now be claimable. `notifyWorkAvailable` alone only ever fires for
    // the card that just changed, never for its dependents, so without this fan-out a
    // push-subscribed agent waiting on a blocked card never hears it unblocked.
    this.notifyDependents(cardId);
    // This card may itself be the last open child of a parent parked by a deferred advance.
    this.resumeDeferredParentAdvance(cardId);
  }

  /**
   * Complete every card already stranded in a terminal stage nobody can act on.
   *
   * `completesOnArrival` fixes arrivals from now on and can do nothing for a card that arrived
   * before it existed. There were seven such cards across two boards when this was written, and
   * EIGHT of ten boards were shaped to keep producing them — every board made from a shipped
   * template is, since all four end in a gateless human stage.
   *
   * Keyed on the STAGE, not on the state alone: a `submitted` card in a working stage is a normal
   * queued card and must not be touched. Cards with open children are skipped for the same reason
   * `advanceCard` defers them — "a parent with half-finished children would read as done".
   *
   * Idempotent: the second pass finds nothing, because the first resolved them.
   */
  async backfillTerminalStageCards(): Promise<{ completed: number }> {
    const stages = this.stages();
    const last = stages[stages.length - 1];
    if (!last || !this.completesOnArrival(last)) return { completed: 0 };

    const rows = this.sql
      .exec(
        `SELECT id FROM cards WHERE current_stage_key = ? AND state NOT IN ('completed', 'canceled', 'rejected', 'failed')`,
        last.key,
      )
      .toArray();

    let completed = 0;
    for (const row of rows) {
      const cardId = row.id as string;
      if (this.openChildCount(cardId) > 0) continue;
      this.resolveCard(cardId, this.getCardHandoffJson(cardId));
      completed++;
    }
    if (completed > 0) {
      this.emit('cards.terminal_backfilled', { completed });
      // A resolved card may free a parent whose replayed advance reports its run.
      await this.scheduleReclaim();
    }
    return { completed };
  }

  /**
   * Put a card into an arbitrary stage/state. **Tests only** — it exists so a test can reproduce the
   * pre-rule shape (`submitted`, in a terminal stage) that no live verb can produce any more.
   * Nothing in the Worker calls it; building the state through real verbs is impossible precisely
   * because the rule being tested now prevents it.
   */
  async debugForceCardState(cardId: string, stageKey: string, state: TaskState): Promise<void> {
    this.sql.exec(
      `UPDATE cards SET current_stage_key = ?, state = ?, updated_at = ? WHERE id = ?`,
      stageKey,
      state,
      this.now(),
      cardId,
    );
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
      .map((r) => this.rowToGate(r as Row));
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
      .map((r) => this.rowToGate(r as Row));
  }

  /** One gate row as a `GateView`. Shared, so one gate and a card's gates cannot disagree. */
  private rowToGate(r: Row): GateView {
    const subjectId = (r.approval_subject_id as string | null) ?? null;
    const approvalSubject = subjectId ? this.approvalSubjectView(subjectId) : null;
    const decision = (r.decision as string | null) ?? null;
    const delivery =
      decision === 'approve_manual' || decision === 'approve_automatic'
        ? {
            mode: (decision === 'approve_manual' ? 'manual' : 'automatic') as 'manual' | 'automatic',
            liveUrl: (r.live_post_url as string | null) ?? null,
            readBackStatus: ((r.live_post_readback_status as 'not_checked' | 'matched' | 'mismatch' | null) ?? 'not_checked'),
            recordedBy: (r.live_post_url_recorded_by as string | null) ?? null,
            recordedAt: (r.live_post_url_recorded_at as string | null) ?? null,
          }
        : null;
    return {
      id: r.id as string,
      cardId: r.card_id as string,
      stageKey: r.stage_key as string,
      status: r.status as 'pending' | 'resolved',
      decision,
      options: JSON.parse(r.options_json as string) as GateOption[],
      producedBy: r.produced_by as string,
      createdAt: r.created_at as string,
      decidedBy: (r.decided_by as string | null) ?? null,
      comment: (r.comment as string | null) ?? null,
      resolvedAt: (r.resolved_at as string | null) ?? null,
      summary: handoffSummary(this.getCardHandoffJson(r.card_id as string)),
      ...(approvalSubject ? { approvalSubject } : {}),
      ...(delivery ? { delivery } : {}),
    };
  }

  private approvalSubjectView(id: string): ApprovalSubjectView | null {
    const row = this.sql.exec(`SELECT * FROM approval_subjects WHERE id = ?`, id).toArray()[0];
    if (!row) return null;
    const stored = row.canonical_bytes as string | ArrayBuffer | ArrayBufferView;
    const canonicalText =
      typeof stored === 'string'
        ? stored
        : new TextDecoder().decode(stored instanceof ArrayBuffer ? new Uint8Array(stored) : stored);
    return {
      id: row.id as string,
      digest: row.digest as string,
      schema: row.schema as string,
      revision: Number(row.revision),
      canonical: JSON.parse(canonicalText) as JsonValue,
    };
  }

  private stageMatches(stage: StageDef, agentId: string, capabilities: string[]): boolean {
    if (stage.ownerKind === 'agent') return stage.owner === agentId;
    // The predicate lives in the contract so the claim path, the `boardCount` diagnostic and the
    // board editor's unstaffed warning can never disagree about what a stage asks for.
    if (stage.ownerKind === 'capability') return stageCapabilitiesMet(stage, capabilities);
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
   * `agentId` is the *authenticated* principal, which is always present for a `spa_` token; it is
   * null only under `DEV_AUTH` when the caller sent no `X-Agent-Id`, where there is no identity to
   * compare and the lease alone authorizes (dev headers are not a credential in a deploy).
   */
  private denyForeignRun(run: Row, agentId: string | null | undefined): { ok: false; code: 'NOT_RUN_OWNER'; message: string } | null {
    if (agentId === null || agentId === undefined) return null;
    if ((run.agent_id as string) === agentId) return null;
    return { ok: false, code: 'NOT_RUN_OWNER', message: 'this run belongs to another agent' };
  }

  // ----- superwitness run reports (superwitness app spec §3.5) -----

  /**
   * A run's reported state just changed: bump `runs.updated_at` and, when reporting is on, upsert
   * the run's outbox row with its current state.
   *
   * SYNCHRONOUS ON PURPOSE (ruling R5). Every caller invokes it in the same synchronous span as the
   * write that changed the run, with no `await` between them, so the Durable Object commits the
   * run change and its report together. Adding an `await` before a call to this breaks that.
   *
   * `updated_at` is strictly increasing per run — `max(now, previous + 1 ms)` — because Workers
   * freezes the clock inside a request and superwitness drops a report whose `reported_at` is not
   * strictly newer than the one it holds (R4).
   */
  private reportRun(runId: string): void {
    const run = this.getRunRow(runId);
    if (!run) return;
    const previous = (run.updated_at as string | null) ?? null;
    const nextMs = previous ? Math.max(this.nowMs(), Date.parse(previous) + 1) : this.nowMs();
    const updatedAt = new Date(nextMs).toISOString();
    this.sql.exec(`UPDATE runs SET updated_at = ? WHERE id = ?`, updatedAt, runId);
    if (!reportingEnabled(this.env)) return;
    this.enqueueRunReport(run, updatedAt);
  }

  /** Upsert `run`'s outbox row with its current state as of `reportedAt` (R6: latest wins, gen bumps). */
  private enqueueRunReport(run: Row, reportedAt: string): void {
    this.sql.exec(
      `INSERT INTO run_reports (run_id, gen, report_json, reported_at, status, attempts, next_attempt_at, last_error, created_at)
       VALUES (?, 1, ?, ?, 'pending', 0, ?, NULL, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         gen = run_reports.gen + 1,
         report_json = excluded.report_json,
         reported_at = excluded.reported_at,
         status = 'pending',
         attempts = 0,
         next_attempt_at = excluded.next_attempt_at,
         last_error = NULL`,
      run.id as string,
      JSON.stringify(this.runReportDraft(run, reportedAt)),
      reportedAt,
      this.nowMs(),
      this.now(),
    );
  }

  private runReportDraft(run: Row, reportedAt: string): RunReportDraft {
    const runId = run.id as string;
    const pendingElicitation =
      Number(this.sql.exec(`SELECT COUNT(*) AS n FROM elicitations WHERE run_id = ? AND status = 'pending'`, runId).one().n) > 0;
    const mapped = mapRunStatus({
      status: run.status as string,
      outcome: (run.outcome as string | null) ?? null,
      pendingElicitation,
      gate: this.gateJudgingRun(run),
    });
    const card = this.sql.exec(`SELECT title FROM cards WHERE id = ?`, run.card_id as string).toArray()[0];
    return {
      boardId: this.getMeta('boardId') ?? '',
      boardName: this.getMeta('name'),
      runId,
      agentId: run.agent_id as string,
      title: (card?.title as string | undefined) ?? null,
      status: mapped.status,
      sourceStatus: mapped.sourceStatus,
      startedAt: (run.started_at as string | null) ?? null,
      endedAt: (run.ended_at as string | null) ?? null,
      reportedAt,
    };
  }

  /**
   * The newest gate judging this run's work (ruling R3). Gates carry `run_id` since 2026-09-29;
   * an older gate has none and is matched as the first gate on the same card and stage opened at
   * or after a `submitted` run ended — the one outcome that always opened one (R21).
   */
  private gateJudgingRun(run: Row): { status: string; decision: string | null } | null {
    const linked = this.sql
      .exec(`SELECT status, decision FROM gates WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, run.id as string)
      .toArray()[0];
    if (linked) return { status: linked.status as string, decision: (linked.decision as string | null) ?? null };
    if ((run.outcome as string | null) !== 'submitted' || !run.ended_at) return null;
    const legacy = this.sql
      .exec(
        `SELECT status, decision FROM gates
          WHERE run_id IS NULL AND card_id = ? AND stage_key = ? AND created_at >= ?
          ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        run.card_id as string,
        run.stage_key as string,
        run.ended_at as string,
      )
      .toArray()[0];
    return legacy ? { status: legacy.status as string, decision: (legacy.decision as string | null) ?? null } : null;
  }

  /** The run a gate judges: its `run_id`, or for a legacy gate, the submitted run it was opened for (R21). */
  private runJudgedByGate(gate: Row): string | null {
    if (gate.run_id) return gate.run_id as string;
    const row = this.sql
      .exec(
        `SELECT id FROM runs WHERE card_id = ? AND stage_key = ? AND outcome = 'submitted' AND ended_at <= ?
          ORDER BY ended_at DESC LIMIT 1`,
        gate.card_id as string,
        gate.stage_key as string,
        gate.created_at as string,
      )
      .toArray()[0];
    return row ? (row.id as string) : null;
  }

  private async drainRunReportsOnce(fetcher: ReporterFetch, nowMs: number): Promise<RunReportDrainResult> {
    const result: RunReportDrainResult = { sent: 0, retried: 0, parked: 0 };
    if (!reportingEnabled(this.env)) return result;
    const boardId = this.getMeta('boardId') ?? '';
    for (let i = 0; i < RUN_REPORT_MAX_BATCHES_PER_DRAIN; i++) {
      const rows = this.sql
        .exec(
          `SELECT run_id, gen, report_json, attempts FROM run_reports
            WHERE status = 'pending' AND next_attempt_at <= ?
            ORDER BY next_attempt_at ASC, run_id ASC LIMIT ?`,
          nowMs,
          RUN_REPORT_BATCH_MAX,
        )
        .toArray();
      if (rows.length === 0) break;
      // A row that does not parse can never be sent: park it here, or it stays due and every
      // alarm re-arms at now for it.
      const due: Array<{ runId: string; gen: number; attempts: number; draft: RunReportDraft }> = [];
      for (const r of rows) {
        const d = { runId: r.run_id as string, gen: Number(r.gen), attempts: Number(r.attempts) };
        let draft: RunReportDraft;
        try {
          draft = JSON.parse(r.report_json as string) as RunReportDraft;
        } catch {
          this.parkRunReport(d, boardId, 'corrupt_report', 0, 'corrupt_report');
          result.parked += 1;
          continue;
        }
        due.push({ ...d, draft });
      }
      if (due.length === 0) continue;

      try {
        const cfg = reporterConfig(this.env);
        if ('error' in cfg) {
          logReporter('warn', { msg: 'superwitness.reporter_misconfigured', 'board.id': boardId, code: cfg.error });
          this.tallyRetry(result, this.retryRunReports(due, nowMs, cfg.error, null), due.length);
          break;
        }

        let executors: Map<string, { principalId: string | null; name: string | null }>;
        try {
          executors = await this.runReportExecutors(due.map((d) => d.draft.agentId));
        } catch {
          logReporter('warn', { msg: 'superwitness.report_retry', 'board.id': boardId, code: 'catalog_unavailable', count: due.length });
          this.tallyRetry(result, this.retryRunReports(due, nowMs, 'catalog_unavailable', null), due.length);
          break;
        }

        // Cap by bytes as well as by count: 100 reports of multibyte text can pass 256 KiB (R12).
        const batch: typeof due = [];
        const reports: RunReport[] = [];
        let bytes = '{"runs":[]}'.length;
        for (const d of due) {
          const report = buildRunReport(d.draft, executors.get(d.draft.agentId) ?? { principalId: null, name: null });
          const size = new TextEncoder().encode(JSON.stringify(report)).length + 1;
          if (batch.length > 0 && bytes + size > RUN_REPORT_BATCH_MAX_BYTES) break;
          batch.push(d);
          reports.push(report);
          bytes += size;
        }

        const outcome = await postRunReports(cfg, this.reporterToken, fetcher, nowMs, reports);
        if (outcome.kind === 'ok') {
          // `gen` guard (R6): a row re-written while this batch was in flight holds a newer snapshot.
          for (const d of batch) this.sql.exec(`DELETE FROM run_reports WHERE run_id = ? AND gen = ?`, d.runId, d.gen);
          result.sent += batch.length;
          continue;
        }
        if (outcome.kind === 'retry') {
          logReporter('warn', { msg: 'superwitness.report_retry', 'board.id': boardId, 'http.status': outcome.status, code: outcome.code, count: batch.length });
          this.tallyRetry(result, this.retryRunReports(batch, nowMs, outcome.code, outcome.retryAfterMs), batch.length);
          break;
        }
        // Refused: the one named item, or the whole batch (R11). The rest stay due and go next loop.
        const refused = outcome.index !== null ? [batch[outcome.index]!] : batch;
        for (const d of refused) this.parkRunReport(d, boardId, `${outcome.status} ${outcome.code}`, outcome.status, outcome.code);
        result.parked += refused.length;
      } catch (err) {
        // Anything unexpected: back the rows off as for a failed send, so the alarm that
        // `scheduleReclaim` arms next is not at now. The alarm's own catch stays the last resort.
        logReporter('error', { msg: 'superwitness.drain_failed', 'board.id': boardId, code: err instanceof Error ? err.name : 'unknown', count: due.length });
        this.tallyRetry(result, this.retryRunReports(due, nowMs, 'drain_error', null), due.length);
        break;
      }
    }
    const dead = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM run_reports WHERE status = 'dead'`).one().n);
    if (dead > 0) {
      logReporter('warn', { msg: 'superwitness.run_reports_dead', metric: 'run_reports_dead', value: dead, 'board.id': boardId });
    }
    return result;
  }

  private tallyRetry(result: RunReportDrainResult, parked: number, total: number): void {
    result.parked += parked;
    result.retried += total - parked;
  }

  /** A retryable failure (R9, R10): back off, or park on the 12th attempt. Returns how many were parked. */
  private retryRunReports(
    rows: Array<{ runId: string; gen: number; attempts: number }>,
    nowMs: number,
    code: string,
    retryAfterMs: number | null,
  ): number {
    let parked = 0;
    const boardId = this.getMeta('boardId') ?? '';
    for (const d of rows) {
      const attempts = d.attempts + 1;
      if (attempts >= RUN_REPORT_MAX_ATTEMPTS) {
        this.parkRunReport(d, boardId, `gave up: ${code}`, 0, code);
        parked += 1;
        continue;
      }
      const delay = Math.max(runReportBackoffMs(attempts), retryAfterMs ?? 0);
      this.sql.exec(
        `UPDATE run_reports SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE run_id = ? AND gen = ?`,
        attempts,
        nowMs + delay,
        code,
        d.runId,
        d.gen,
      );
    }
    return parked;
  }

  /** Park a row: kept, never retried, counted as `run_reports_dead` (R16). Ids and codes only in the log. */
  private parkRunReport(
    d: { runId: string; gen: number },
    boardId: string,
    lastError: string,
    status: number,
    code: string,
  ): void {
    this.sql.exec(
      `UPDATE run_reports SET status = 'dead', attempts = attempts + 1, last_error = ? WHERE run_id = ? AND gen = ?`,
      lastError,
      d.runId,
      d.gen,
    );
    logReporter('warn', {
      msg: 'superwitness.report_parked',
      metric: 'run_reports_dead',
      'board.id': boardId,
      'run.id': d.runId,
      'http.status': status,
      code,
    });
  }

  /** Executor identity from the catalog (ruling R7). */
  private async runReportExecutors(agentIds: string[]): Promise<Map<string, { principalId: string | null; name: string | null }>> {
    const tenantId = this.getMeta('tenantId') ?? '';
    const [principals, names] = await Promise.all([
      principalIdsFor(this.env.DB, tenantId, agentIds),
      agentNamesFor(this.env.DB, tenantId, agentIds),
    ]);
    const out = new Map<string, { principalId: string | null; name: string | null }>();
    for (const id of new Set(agentIds)) out.set(id, { principalId: principals.get(id) ?? null, name: names.get(id) ?? null });
    return out;
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

    // Third job on the one alarm: the superwitness outbox. Only while reporting is on, so rows left
    // behind when it was switched off cannot wake the board on a loop.
    const reportDue = reportingEnabled(this.env)
      ? this.sql.exec(`SELECT MIN(next_attempt_at) AS t FROM run_reports WHERE status = 'pending'`).one().t
      : null;
    const reportAt = reportDue === null || reportDue === undefined ? null : Math.max(Number(reportDue), this.nowMs());

    const next = [reclaimAt, drainAt, reportAt].filter((t): t is number => t !== null).sort((a, b) => a - b)[0];
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
    const boardId = this.getMeta('boardId');
    const subjectId = (gate.approval_subject_id as string | null) ?? null;
    const subject = subjectId ? this.approvalSubjectView(subjectId) : null;
    const approvalSubject = subject
      ? { id: subject.id, digest: subject.digest, schema: subject.schema, revision: subject.revision }
      : null;
    return {
      event: 'gate.pending',
      boardId,
      // `?? ''` rather than omitted: see `GatePendingBody.boardName`.
      boardName: this.getMeta('name') ?? '',
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
      handoffSummary: approvalSubject ? null : handoffSummary(this.getCardHandoffJson(cardId)),
      ...(approvalSubject
        ? {
            approvalSubject,
            reviewUrl: `/b/${encodeURIComponent(boardId!)}/c/${encodeURIComponent(cardId)}`,
          }
        : {}),
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

  /**
   * The body a question travels in, built once from the elicitation's own row.
   *
   * Read from the row rather than from the activity that produced it, for the reason
   * `gatePendingBody` gives about gates: a question must keep the options it was ASKED
   * with. An agent that re-posted different options would otherwise change a question
   * out from under the person answering it.
   *
   * `null` when the card is gone — a question about a deleted card has nothing to ask
   * about, and is the same case the gate builder already handles.
   */
  private elicitationPendingBody(row: Row): ElicitationPendingBody | null {
    const cardId = row.card_id as string;
    const card = this.getCard(cardId);
    if (!card) return null;
    return {
      event: 'elicitation.pending',
      boardId: this.getMeta('boardId'),
      boardName: this.getMeta('name') ?? '',
      cardId,
      cardTitle: card.title,
      elicitationId: row.id as string,
      runId: row.run_id as string,
      stageKey: row.stage_key as string,
      agentId: row.agent_id as string,
      question: (row.question as string) ?? '',
      options: (JSON.parse(row.options_json as string) as GateOption[]).map((o) => ({
        id: o.name,
        label: o.title,
      })),
      ts: row.created_at as string,
    };
  }

  /**
   * Queue `elicitation.pending` for a question that just opened.
   *
   * **Fan-out is by subscription only** — the same rule as `notifyGatePending` and for
   * the same reason, which is worth restating because the temptation is to copy
   * `notifyWorkAvailable` instead. `work.available` is addressed to whoever could
   * *claim* a stage, so it matches on capability. A question is addressed to a
   * **human**. Matching on capability would send it to whichever agents happen to
   * advertise the stage's capability, and to nobody at all when the stage is one a
   * person owns.
   */
  private notifyElicitationPending(elicitationId: string): void {
    const row = this.sql.exec(`SELECT * FROM elicitations WHERE id = ?`, elicitationId).toArray()[0] as
      | Row
      | undefined;
    if (!row) return;
    const payload = this.elicitationPendingBody(row);
    if (!payload) return;
    const body = JSON.stringify(payload);
    const ts = this.now();
    for (const cfg of this.sql.exec(`SELECT * FROM push_configs`).toArray()) {
      const events = JSON.parse(cfg.events_json as string) as string[];
      if (!events.includes('elicitation.pending')) continue;
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
   * Every question still waiting on a human, in the body a push carries.
   *
   * The floor beneath push, exactly as `pendingGateDeliveries` is: a delivery is retried
   * five times and then dead-lettered, at which point the card is blocked on an answer
   * nobody was told about and neither side is looking. This is what lets a reader ask
   * rather than wait to be told, and it is why the per-board push-config rollout does
   * not block the feature — a board whose config predates the event is served late
   * rather than not at all.
   *
   * It carries a second meaning the gate version does not need as badly. A question is
   * superseded by the next question on the same card (`openElicitation` retires the
   * previous one), so **absence from this list** is how a reader learns that a question
   * it already showed can no longer be answered. A stale question that still looks
   * tappable is a question that will be tapped.
   */
  async pendingElicitationDeliveries(): Promise<ElicitationPendingBody[]> {
    return this.pendingElicitationRows()
      .map((r) => this.elicitationPendingBody(r))
      .filter((b): b is ElicitationPendingBody => b !== null);
  }

  /** The gate row, or null. */
  private getGateRow(gateId: string): Row | null {
    return (this.sql.exec(`SELECT * FROM gates WHERE id = ?`, gateId).toArray()[0] as Row) ?? null;
  }

  /**
   * Every gate still waiting on a human, in the body a push carries.
   *
   * The floor beneath push. superpipeline retries a delivery five times and then
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

  /** Record events to whoever subscribed (Superlibrary spec §5). One delivery per matching config. */
  private queueRecordPush(type: string, seq: number, payload: Record<string, unknown>, ts: string): void {
    const configs = this.sql.exec(`SELECT id, url, events_json FROM push_configs`).toArray()
      .filter((c) => (JSON.parse(c.events_json as string) as string[]).includes(type));
    if (configs.length === 0) return;
    const body: RecordPushBody = { event: type, boardId: this.getMeta('boardId') as string, seq, ts, cardIds: cardIdsOf(payload) };
    const text = JSON.stringify(body);
    for (const c of configs) {
      this.sql.exec(
        `INSERT INTO push_deliveries (config_id, url, body, status, attempts, created_at) VALUES (?, ?, ?, 'pending', 0, ?)`,
        c.id, c.url, text, ts,
      );
    }
    // The one alarm drains pending deliveries (scheduleReclaim computes drainAt from them).
    void this.scheduleReclaim().catch((err) => console.error('record push: alarm not armed', String(err)));
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
    if (isRecordEvent(type)) this.queueRecordPush(type, seq, payload, ts);
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
    // Precompute per-card cost + attempt count in grouped queries instead of N point queries —
    // allCards() feeds every snapshot, which is the live-feed hot path. Task 14's three child-card
    // fields (`parentCardId`, `openChildCount`, the cost half of `costUsdRollup`) joined this same
    // batch rather than adding three more point queries per card back onto `rowToCard`.
    const costByCard = new Map<string, number>();
    for (const r of this.sql.exec(`SELECT card_id, COALESCE(SUM(cost_usd), 0) AS c FROM usage_records GROUP BY card_id`).toArray()) {
      costByCard.set(r.card_id as string, Number(r.c));
    }
    const attemptsByCard = new Map<string, number>();
    for (const r of this.sql.exec(`SELECT card_id, COUNT(*) AS n FROM runs GROUP BY card_id`).toArray()) {
      attemptsByCard.set(r.card_id as string, Number(r.n));
    }
    // Child → parent, over every `parent` edge on the board — one row per child, so a direct map.
    const parentByChild = new Map<string, string>();
    for (const r of this.sql.exec(`SELECT to_card_id, from_card_id FROM card_links WHERE kind = 'parent'`).toArray()) {
      parentByChild.set(r.to_card_id as string, r.from_card_id as string);
    }
    // Parent → its open-child count, the same rule `openChildCount` asks per-card, grouped instead.
    const openChildCountByParent = new Map<string, number>();
    for (const r of this.sql
      .exec(
        `SELECT l.from_card_id AS parent_id, COUNT(*) AS n FROM card_links l JOIN cards ch ON ch.id = l.to_card_id
           WHERE l.kind = 'parent' AND ch.state NOT IN ${BoardDO.RESOLVED_SQL} GROUP BY l.from_card_id`,
      )
      .toArray()) {
      openChildCountByParent.set(r.parent_id as string, Number(r.n));
    }
    // Parent → its children's summed cost, the same query `childrenCost` runs per-card, grouped.
    const childrenCostByParent = new Map<string, number>();
    for (const r of this.sql
      .exec(
        `SELECT l.from_card_id AS parent_id, COALESCE(SUM(u.cost_usd), 0) AS c FROM card_links l
           JOIN usage_records u ON u.card_id = l.to_card_id
          WHERE l.kind = 'parent' GROUP BY l.from_card_id`,
      )
      .toArray()) {
      childrenCostByParent.set(r.parent_id as string, Number(r.c));
    }
    // Blocked card → its unresolved blockers (id, title), grouped — Task 17's `CardView.blockedBy`,
    // the same `kind = 'blocks'` + `RESOLVED_SQL` predicate `unresolvedBlockerExists()` tests for,
    // as a SELECT instead of an EXISTS, run once for the whole board rather than once per card
    // (`blockersOf`'s per-card version exists only for `rowToCard`'s single-card fallback below).
    const blockersByCard = new Map<string, Array<{ cardId: string; title: string }>>();
    for (const r of this.sql
      .exec(
        `SELECT l.to_card_id AS blocked_id, b.id AS blocker_id, b.title AS blocker_title
           FROM card_links l JOIN cards b ON b.id = l.from_card_id
          WHERE l.kind = 'blocks' AND b.state NOT IN ${BoardDO.RESOLVED_SQL}`,
      )
      .toArray()) {
      const blockedId = r.blocked_id as string;
      const list = blockersByCard.get(blockedId) ?? [];
      list.push({ cardId: r.blocker_id as string, title: r.blocker_title as string });
      blockersByCard.set(blockedId, list);
    }
    return this.sql
      .exec(`SELECT * FROM cards ORDER BY priority DESC, (due_at IS NULL), due_at ASC, created_at ASC`)
      .toArray()
      .map((r) => {
        const id = r.id as string;
        return this.rowToCard(r, {
          costUsd: costByCard.get(id) ?? 0,
          attemptCount: attemptsByCard.get(id) ?? 0,
          parentCardId: parentByChild.get(id) ?? null,
          openChildCount: openChildCountByParent.get(id) ?? 0,
          childrenCost: childrenCostByParent.get(id) ?? 0,
          blockedBy: blockersByCard.get(id) ?? [],
        });
      });
  }

  private rowToCard(
    row: Row,
    pre?: {
      costUsd: number;
      attemptCount: number;
      parentCardId: string | null;
      openChildCount: number;
      childrenCost: number;
      blockedBy: Array<{ cardId: string; title: string }>;
    },
  ): CardView {
    const id = row.id as string;
    const costUsd = pre?.costUsd ?? this.cardCost(id);
    const cardCap = this.budgetCap('budgetCardUsdCap');
    const attemptCount = pre?.attemptCount ?? Number(this.sql.exec(`SELECT COUNT(*) AS n FROM runs WHERE card_id = ?`, id).one().n);
    // `pre` (not `??`) for these four: `parentCardId` is legitimately `null` for most cards, and
    // `??` would treat a batched `null` as "missing" and re-query — still correct, just defeating
    // the batch it's here to avoid. `blockedBy` joins this group for the same reason from the other
    // direction: an unblocked card's real, batched answer is `[]`, and testing the array itself
    // (its length, or `pre?.blockedBy ?? fallback`) risks mistaking that legitimate empty answer for
    // a missing one. Branching on `pre` — the presence of the whole precomputed object, never the
    // field's own value — is the one test that can't make that mistake for any of the four.
    const parentCardId = pre ? pre.parentCardId : this.parentIdOf(id);
    const openChildCount = pre ? pre.openChildCount : this.openChildCount(id);
    const childrenCost = pre ? pre.childrenCost : this.childrenCost(id);
    const blockedBy = pre ? pre.blockedBy : this.blockersOf(id);
    return {
      id,
      title: row.title as string,
      spec: JSON.parse(row.spec_json as string),
      ownerUserId: row.owner_user_id as string,
      queuedBy: (row.queued_by as string | null) ?? null,
      queuedByAgentId: (row.queued_by_agent_id as string | null) ?? null,
      currentRunId: (row.current_run_id as string | null) ?? null,
      queuedGrant: row.queued_grant ? (JSON.parse(row.queued_grant as string) as string[]) : null,
      labels: row.labels ? (JSON.parse(row.labels as string) as string[]) : [],
      // Columns on the card row, same as `dueAt` below — no query, no `pre` entry, read straight
      // off what `SELECT *` already fetched. A value here that no longer resolves (the project or
      // milestone was deleted) is read as-is; it is the caller's job to decide what to do with it,
      // never this DO's.
      projectId: (row.project_id as string | null) ?? null,
      milestoneId: (row.milestone_id as string | null) ?? null,
      dueAt: (row.due_at as string | null) ?? null,
      // Omitted rather than null when absent: the field means "there is a reason", and
      // a present-but-empty one would make every reader check two things.
      ...(row.needs_human_json
        ? { needsHuman: JSON.parse(row.needs_human_json as string) as CardNeedsHuman }
        : {}),
      archivedAt: (row.archived_at as string | null) ?? null,
      currentStageKey: row.current_stage_key as string,
      state: row.state as TaskState,
      delegateAgentId: (row.delegate_agent_id as string | null) ?? null,
      priority: Number(row.priority),
      contextId: row.context_id as string,
      createdAt: row.created_at as string,
      updatedAt: (row.updated_at as string | null) ?? null,
      stateSince: ((row.state_since as string | null) ?? (row.updated_at as string | null) ?? (row.created_at as string)),
      costUsd,
      // `>=` matches the enforcement gate (postActivity rejects once at/over the cap), so the red
      // chip appears exactly when billing stops.
      overBudget: cardCap !== null && costUsd >= cardCap,
      attemptCount,
      parentCardId,
      openChildCount,
      // Own cost plus one level of children. One level, not recursive: nesting deeper than one is
      // not a shape this board model encourages, and an unbounded walk inside `rowToCard` would run
      // on every card of every board read. NOT folded into `costUsd` above — see that field's own
      // comment on `CardView` and `childrenCost`'s, below `cardCost`.
      costUsdRollup: costUsd + childrenCost,
      blockedBy,
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
      runId: (row.run_id as string | null) ?? null,
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

  private rowToLink(row: Row): LinkView {
    return {
      fromCardId: row.from_card_id as string,
      toCardId: row.to_card_id as string,
      kind: row.kind as LinkKind,
      createdAt: row.created_at as string,
      createdBy: (row.created_by as string | null) ?? null,
    };
  }

  private mustGetLink(fromCardId: string, toCardId: string, kind: LinkKind): LinkView {
    const row = this.sql
      .exec(`SELECT * FROM card_links WHERE from_card_id = ? AND to_card_id = ? AND kind = ?`, fromCardId, toCardId, kind)
      .toArray()[0];
    if (!row) throw new Error(`invariant violation: link ${fromCardId}->${toCardId} (${kind}) missing immediately after write`);
    return this.rowToLink(row);
  }

  /** Every edge on the board, as the pure `wouldCycle` predicate wants them — no DO-specific shape. */
  private allLinks(): LinkRow[] {
    return this.sql
      .exec(`SELECT from_card_id, to_card_id, kind FROM card_links`)
      .toArray()
      .map((r) => ({
        fromCardId: r.from_card_id as string,
        toCardId: r.to_card_id as string,
        kind: r.kind as LinkKind,
      }));
  }

  private getScheduleRow(id: string): Row | null {
    return this.sql.exec(`SELECT * FROM schedules WHERE id = ?`, id).toArray()[0] ?? null;
  }

  private rowToSchedule(row: Row): ScheduleView {
    return {
      id: row.id as string,
      enabled: Number(row.enabled) === 1,
      title: row.title as string,
      spec: JSON.parse(row.spec_json as string) as JsonValue,
      priority: Number(row.priority),
      labels: JSON.parse(row.labels as string) as string[],
      stageKey: (row.stage_key as string | null) ?? null,
      rule: row.rule as string,
      timezone: row.timezone as string,
      overlap: row.overlap as 'skip' | 'allow',
      nextFireAt: row.next_fire_at as string,
      lastFiredAt: (row.last_fired_at as string | null) ?? null,
      lastCardId: (row.last_card_id as string | null) ?? null,
      skipCount: Number(row.skip_count),
      createdBy: (row.created_by as string | null) ?? null,
    };
  }

  private mustGetSchedule(id: string): ScheduleView {
    const row = this.getScheduleRow(id);
    if (!row) throw new Error(`invariant violation: schedule ${id} missing immediately after write`);
    return this.rowToSchedule(row);
  }

  // ----- metering (docs/07 §6) -----

  private cardCost(cardId: string): number {
    return Number(this.sql.exec(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage_records WHERE card_id = ?`, cardId).one().c);
  }

  /**
   * The summed cost of a card's direct children.
   *
   * One level deep, matching `costUsdRollup`. Deliberately a sibling of `cardCost` rather than a
   * parameter to it: `cardCost` feeds the budget gate (`boardOverBudget`'s cousin, the per-card cap
   * check in `postActivity`) and must keep meaning "what this card itself spent".
   */
  private childrenCost(cardId: string): number {
    return Number(
      this.sql
        .exec(
          `SELECT COALESCE(SUM(u.cost_usd), 0) AS c FROM usage_records u
             WHERE u.card_id IN (SELECT to_card_id FROM card_links WHERE from_card_id = ? AND kind = 'parent')`,
          cardId,
        )
        .one().c,
    );
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
      stale: this.staleSettings(),
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
