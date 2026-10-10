/**
 * The optional note a person leaves with a gate decision.
 *
 * The API stores whatever string it is sent (no length rule of its own on a gate), so the limit
 * here mirrors the one the board puts on a card comment, `COMMENT_MAX_BYTES` (8192), as characters.
 */
export const GATE_NOTE_MAX = 8192;

/** An empty or whitespace-only note is no comment at all: `undefined`, never `''`. */
export function noteToComment(note: string): string | undefined {
  const t = note.trim();
  return t === '' ? undefined : t;
}
