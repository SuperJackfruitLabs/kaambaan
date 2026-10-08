/**
 * The "Details" section of the card drawer: every spec field the drawer does not already render.
 *
 * A card's spec is free-form (`z.record(z.string(), z.unknown())`) and the agent working the card
 * receives all of it. The drawer used to show `description`, `plan` and `acceptanceCriteria` and
 * nothing else, so whatever else the author wrote — a role, a nested decision, a list of operator
 * actions — was on the wire and invisible to the person reviewing the card.
 */

/**
 * Keys the drawer renders in their own sections, or owns elsewhere. `labels` and `due` are
 * legacy spec fields superseded by real columns (`card.labels`, `card.dueAt`); repeating a stale
 * copy under Details would be two sources of truth for one value.
 */
export const DRAWER_OWNED_KEYS: ReadonlySet<string> = new Set(['description', 'plan', 'acceptanceCriteria', 'labels', 'due']);

/** How many levels of nesting are drawn as groups before the rest is shown as compact JSON. */
export const MAX_DEPTH = 4;

export interface SpecEntry {
  key: string;
  value: unknown;
}

/** `portraitDecision` → "Portrait decision", `due_by_date` → "Due by date", `prURL` → "Pr URL". */
export function humaniseKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-]+/)
    .filter(Boolean)
    .map((w, i) => {
      if (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) return w; // an acronym stays one
      const lower = w.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    });
  return words.join(' ');
}

/**
 * An href only for an absolute http(s) URL; null for anything else. The spec is written by
 * whoever (or whatever) created the card, so `javascript:`, `data:` and friends must never
 * become a clickable link.
 */
export function safeHref(s: string): string | null {
  const t = s.trim();
  if (!/^https?:\/\//i.test(t) || /\s/.test(t)) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export interface TextPart {
  text: string;
  href?: string;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/gi;
/** Punctuation that ends a sentence rather than the URL. */
const TRAILING = /[.,;:!?)\]}]+$/;

/** Split prose into plain text and http(s) links, so a URL inside a sentence is still clickable. */
export function splitLinks(s: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of s.matchAll(URL_IN_TEXT)) {
    let url = m[0];
    const trail = url.match(TRAILING)?.[0] ?? '';
    if (trail) url = url.slice(0, -trail.length);
    const href = safeHref(url);
    if (!href) continue;
    const start = m.index ?? 0;
    if (start > last) parts.push({ text: s.slice(last, start) });
    parts.push({ text: url, href: url });
    last = start + url.length;
  }
  if (last < s.length) parts.push({ text: s.slice(last) });
  return parts.length > 0 ? parts : [{ text: s }];
}

/** True for values with nothing to show: null, undefined, '', [] and {}. `false` and `0` are values. */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Entries of `obj` worth showing, in the author's order. */
export function visibleEntries(obj: Record<string, unknown>): SpecEntry[] {
  return Object.entries(obj)
    .filter(([, v]) => !isEmptyValue(v))
    .map(([key, value]) => ({ key, value }));
}

/** The spec fields that belong under Details: everything the drawer does not own, minus empties. */
export function specDetailEntries(spec: Record<string, unknown> | null | undefined): SpecEntry[] {
  if (!isPlainObject(spec)) return [];
  return visibleEntries(spec).filter((e) => !DRAWER_OWNED_KEYS.has(e.key));
}

/** Count leaves and characters, so a sprawling spec can start collapsed. */
function measure(v: unknown, acc: { leaves: number; chars: number }, depth = 0): void {
  if (depth > MAX_DEPTH + 2) return;
  if (Array.isArray(v)) for (const x of v) measure(x, acc, depth + 1);
  else if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) { acc.chars += k.length; measure(x, acc, depth + 1); }
  else { acc.leaves += 1; acc.chars += String(v).length; }
}

export const LONG_LEAVES = 10;
export const LONG_CHARS = 1200;

export function isLongSpec(entries: SpecEntry[]): boolean {
  const acc = { leaves: 0, chars: 0 };
  for (const e of entries) { acc.chars += e.key.length; measure(e.value, acc); }
  return acc.leaves > LONG_LEAVES || acc.chars > LONG_CHARS;
}

/** The tail of a too-deep value, as one line of JSON. Never throws (cycles, BigInt). */
export function compactJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
