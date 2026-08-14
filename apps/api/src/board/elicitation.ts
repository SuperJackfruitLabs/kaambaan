/**
 * Reading the choices an agent offered on an `elicitation` (docs/04 §4).
 *
 * They ride in the activity's **`parameter`** — the one field the board persists and hands back.
 * (`signalMetadata` used to look like a second home for them; nothing read it, so an agent that put
 * its options there had them dropped and the human got a question with no answers to pick.)
 *
 * Harnesses spell an option a few ways, so we normalize rather than refuse: `{name,title}` is
 * canonical, `{id,label}` (MCP elicitation / the Matrix dispatch-card shape) is accepted, and a bare
 * string is both. Names must be unique within one question — resolution is by name, so a duplicate
 * would be ambiguous — and the first spelling of a name wins.
 */
import type { GateOption, JsonValue } from './board-do';

function asOption(raw: JsonValue): GateOption | null {
  if (typeof raw === 'string') {
    const name = raw.trim();
    return name === '' ? null : { name, title: name };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, JsonValue>;
  const name = typeof o.name === 'string' ? o.name.trim() : typeof o.id === 'string' ? o.id.trim() : '';
  if (name === '') return null;
  const title = typeof o.title === 'string' && o.title.trim() !== '' ? o.title.trim() : typeof o.label === 'string' && o.label.trim() !== '' ? o.label.trim() : name;
  const option: GateOption = { name, title };
  if (typeof o.promptFill === 'string') option.promptFill = o.promptFill;
  if (typeof o.interactive === 'boolean') option.interactive = o.interactive;
  return option;
}

/** The options carried by an elicitation's `parameter`: `[…]` or `{ options: […] }`, else none. */
export function parseElicitationOptions(parameter: JsonValue | null | undefined): GateOption[] {
  if (parameter === null || parameter === undefined) return [];
  const list = Array.isArray(parameter)
    ? parameter
    : typeof parameter === 'object' && Array.isArray((parameter as Record<string, JsonValue>).options)
      ? ((parameter as Record<string, JsonValue>).options as JsonValue[])
      : null;
  if (!list) return [];
  const seen = new Set<string>();
  const options: GateOption[] = [];
  for (const raw of list) {
    const option = asOption(raw);
    if (!option || seen.has(option.name)) continue;
    seen.add(option.name);
    options.push(option);
  }
  return options;
}
