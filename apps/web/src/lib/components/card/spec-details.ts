/**
 * The "Details" section of the card drawer: every spec field the drawer does not already render.
 *
 * A card's spec is free-form (`z.record(z.string(), z.unknown())`) and the agent working the card
 * receives all of it. The drawer used to show `description`, `plan` and `acceptanceCriteria` and
 * nothing else, so whatever else the author wrote — a role, a nested decision, a list of operator
 * actions — was on the wire and invisible to the person reviewing the card.
 */

import { planRendersWhole } from './plan';

/**
 * Keys the drawer renders in their own sections, or owns elsewhere. `labels` and `due` are
 * legacy spec fields superseded by real columns (`card.labels`, `card.dueAt`); repeating a stale
 * copy under Details would be two sources of truth for one value.
 */
export const DRAWER_OWNED_KEYS: ReadonlySet<string> = new Set(['description', 'acceptanceCriteria', 'labels', 'due']);

/**
 * How many levels of nesting are drawn as groups before the rest folds behind a "Show more"
 * disclosure. Real handoffs reach five (`scope.auditBaseline.forgeReadProbes.<repo>`), so six
 * draws them whole; the fold is for the pathological, and it never falls back to JSON.
 */
export const MAX_DEPTH = 6;

/** A list longer than {@link LIST_FOLD_AFTER} shows this many items and a "Show all N" button. */
export const LIST_PREVIEW = 8;
/** Hiding one or two items behind a button costs more than showing them. */
const LIST_FOLD_AFTER = LIST_PREVIEW + 2;

export interface SpecEntry {
  key: string;
  value: unknown;
}

/**
 * `portraitDecision` → "Portrait decision", `due_by_date` → "Due by date", `prURL` → "Pr URL".
 *
 * Only an identifier-shaped key is respelled. A handoff keys things by what they are — a
 * repository (`SuperJackfruitLabs/agentpod`), a path, a column (`runs.handoff_json`), or a phrase
 * the agent already wrote as words — and lowercasing or splitting those would misname them.
 */
export function humaniseKey(key: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) return key;
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

/**
 * Entries inside a value, in the author's order. Unlike the top level, a null or empty field here
 * is shown (as a dash): `refusedHandoff: null` says something, and dropping it would not.
 */
export function nestedEntries(obj: Record<string, unknown>): SpecEntry[] {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => ({ key, value }));
}

/** Entries of `obj` worth showing, in the author's order. */
export function visibleEntries(obj: Record<string, unknown>): SpecEntry[] {
  return Object.entries(obj)
    .filter(([, v]) => !isEmptyValue(v))
    .map(([key, value]) => ({ key, value }));
}

/**
 * The spec fields that belong under Details: everything the drawer does not own, minus empties.
 * `plan` is owned only when the checklist drew every item of it; a plan it could not read (or read
 * only in part) stays here as written, so no data is hidden.
 */
export function specDetailEntries(spec: Record<string, unknown> | null | undefined): SpecEntry[] {
  if (!isPlainObject(spec)) return [];
  return visibleEntries(spec).filter((e) => !DRAWER_OWNED_KEYS.has(e.key) && !(e.key === 'plan' && planRendersWhole(e.value)));
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

/** The value as indented JSON, for the "View raw JSON" toggle. Never throws (cycles, BigInt). */
export function rawJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Past this, a string is prose however it starts; parsing it would only cost time. */
const MAX_JSON_STRING = 200_000;

/**
 * An agent sometimes stores a JSON document as a string — `approach: "{\"decision\":…}"` — and it
 * then reads as one wall of escaped quotes. A string that is WHOLLY a JSON object or array is read
 * as that value; anything else (a JSON scalar, JSON inside a sentence, a near-miss) stays a string.
 * `JSON.parse` only: nothing is ever evaluated.
 */
export function parseJsonString(s: string): Record<string, unknown> | unknown[] | null {
  const t = s.trim();
  if (t.length < 2 || t.length > MAX_JSON_STRING) return null;
  const open = t[0];
  const close = t[t.length - 1];
  if (!((open === '{' && close === '}') || (open === '[' && close === ']'))) return null;
  try {
    const v: unknown = JSON.parse(t);
    return Array.isArray(v) || isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** The value to draw: a JSON-document string becomes its value; everything else is as given. */
export function normaliseValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  return parseJsonString(v) ?? v;
}

/** True when `v` is a group (object or array) at a depth that folds behind "Show more". */
export function shouldCollapse(v: unknown, depth: number): boolean {
  return depth >= MAX_DEPTH && (Array.isArray(v) || isPlainObject(v));
}

/** The items of a list to draw, and how many are behind "Show all". */
export function listWindow<T>(items: T[], showAll: boolean): { shown: T[]; hidden: number } {
  if (showAll || items.length <= LIST_FOLD_AFTER) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, LIST_PREVIEW), hidden: items.length - LIST_PREVIEW };
}

export interface InlinePart extends TextPart {
  code?: boolean;
}

/**
 * Prose split into text, `code` (a backticked span, as agents write file names and commands) and
 * http(s) links. A URL inside a code span is code, not a link; a lone backtick is just a backtick.
 */
export function inlineParts(s: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  for (const m of s.matchAll(/`([^`\n]+)`/g)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(...splitLinks(s.slice(last, start)));
    parts.push({ text: m[1]!, code: true });
    last = start + m[0].length;
  }
  if (last < s.length) parts.push(...splitLinks(s.slice(last)));
  return parts.length > 0 ? parts : [{ text: s }];
}
