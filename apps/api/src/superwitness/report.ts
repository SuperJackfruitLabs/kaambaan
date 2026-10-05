/**
 * The superwitness run report (superwitness app spec §3.2, §3.5): what superpipeline tells
 * superwitness about one run.
 *
 * Pure — no bindings, no I/O — so the status mapping and the wire shape are tested without a
 * Durable Object. The board stores a `RunReportDraft` in its outbox; the drain turns it into a
 * `RunReport` once it has resolved the executor from the catalog.
 */

export const REPORT_SOURCE = 'superpipeline';

export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

/** What the board knows about a run when its state changes. */
export interface RunFacts {
  /** `runs.status`: `working` or `ended`. */
  status: string;
  /** `runs.outcome`: null while the run is working. */
  outcome: string | null;
  /** The run asked a question that is still pending. */
  pendingElicitation: boolean;
  /** The newest gate judging this run's work, or null. */
  gate: { status: string; decision: string | null } | null;
}

/**
 * The status mapping (plan "Status mapping"). `queued` is never produced: a run row exists only
 * from a claim (ruling R1). `sourceStatus` is the raw run string (R2).
 */
export function mapRunStatus(f: RunFacts): { status: RunStatus; sourceStatus: string } {
  const sourceStatus = clip(f.outcome ?? f.status, 64) || 'unknown';
  if (f.status === 'working') return { status: f.pendingElicitation ? 'waiting' : 'running', sourceStatus };
  switch (f.outcome) {
    case 'completed':
    case 'submitted': {
      if (!f.gate) return { status: f.outcome === 'completed' ? 'succeeded' : 'waiting', sourceStatus };
      if (f.gate.status === 'pending') return { status: 'waiting', sourceStatus };
      if (f.gate.status === 'cancelled') return { status: 'cancelled', sourceStatus };
      return { status: f.gate.decision === 'approve' ? 'succeeded' : 'failed', sourceStatus };
    }
    case 'released':
      return { status: 'cancelled', sourceStatus };
    default:
      // blocked, crashed, reclaimed — and anything this mapping has not met yet.
      return { status: 'failed', sourceStatus };
  }
}

/** What the outbox stores for a run: everything but the executor, which needs the catalog. */
export interface RunReportDraft {
  boardId: string;
  boardName: string | null;
  runId: string;
  agentId: string;
  title: string | null;
  status: RunStatus;
  sourceStatus: string;
  startedAt: string | null;
  endedAt: string | null;
  reportedAt: string;
}

/** The wire shape, field for field spec §3.2. */
export interface RunReport {
  source: string;
  external_ref: string;
  scope: { id: string; name?: string };
  title?: string;
  executor: { id?: string; name: string };
  status: RunStatus;
  source_status: string;
  started_at: string | null;
  ended_at: string | null;
  reported_at: string;
}

const PRINCIPAL_ID = /^prn_[0-9a-f]{20}$/;

export function externalRef(boardId: string, runId: string): string {
  return `${boardId}/${runId}`;
}

/** Trim, then cut to `max` code points (the schema's `maxLength` counts characters, not bytes). */
export function clip(s: string | null | undefined, max: number): string {
  if (!s) return '';
  const chars = Array.from(s.trim());
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

export function buildRunReport(
  d: RunReportDraft,
  executor: { principalId: string | null; name: string | null },
): RunReport {
  const scopeName = clip(d.boardName, 200);
  const title = clip(d.title, 200);
  const executorName = clip(executor.name, 200) || clip(d.agentId, 200) || 'unknown';
  return {
    source: REPORT_SOURCE,
    external_ref: externalRef(d.boardId, d.runId),
    scope: { id: clip(d.boardId, 128), ...(scopeName ? { name: scopeName } : {}) },
    ...(title ? { title } : {}),
    executor: {
      ...(executor.principalId && PRINCIPAL_ID.test(executor.principalId) ? { id: executor.principalId } : {}),
      name: executorName,
    },
    status: d.status,
    source_status: clip(d.sourceStatus, 64) || 'unknown',
    started_at: d.startedAt,
    ended_at: d.endedAt,
    reported_at: d.reportedAt,
  };
}
