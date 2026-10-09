/** Events pushed by their own fan-outs before record events existed. */
export const PUSHED_EVENTS = ['work.available', 'cards.stale', 'elicitation.pending', 'gate.pending'] as const;

/**
 * Board events a push config may subscribe to as "record" events (Superlibrary spec §5, plus the
 * link events its `supersedes` mapping needs). The body names the cards and nothing else: a
 * subscriber reads the card back with its own credential, so a push never carries more than that
 * credential could read.
 *
 * `card.moved` (a manual stage move) and `card.blocked` (a parked card, including the circuit
 * breaker) are emitted on main and change what a record shows. `card.failed` is not emitted
 * today; it stays so a subscriber written against it keeps working if it ever is.
 */
export const RECORD_EVENTS = [
  'card.created', 'card.updated', 'card.moved', 'card.advanced', 'card.completed', 'card.rejected', 'card.failed',
  'card.blocked', 'card.deleted', 'card.resumed', 'card.comment.added', 'card.comment.deleted', 'gate.resolved',
  'link.added', 'link.removed',
] as const;
const RECORD = new Set<string>(RECORD_EVENTS);
export const isRecordEvent = (type: string) => RECORD.has(type);
export const SUBSCRIBABLE_EVENTS: ReadonlySet<string> = new Set<string>([...PUSHED_EVENTS, ...RECORD_EVENTS]);

export interface RecordPushBody { event: string; boardId: string; seq: number; ts: string; cardIds: string[] }

/** The cards an event is about, from the payloads `emit` already carries. */
export function cardIdsOf(payload: Record<string, unknown>): string[] {
  // link.added carries { link }; link.removed carries { fromCardId, toCardId, kind } at top level.
  const link = payload.link as { fromCardId?: string; toCardId?: string } | undefined;
  const from = link?.fromCardId ?? (payload.fromCardId as string | undefined);
  const to = link?.toCardId ?? (payload.toCardId as string | undefined);
  if (from && to) return [from, to];
  const card = payload.card as { id?: string } | undefined;
  const id = (payload.cardId as string | undefined) ?? card?.id;
  return id ? [id] : [];
}
