/**
 * Argument parsing, split out so it can be tested — `index.ts` ends in `await main(...)`, so
 * importing it to reach a helper would run the CLI.
 */

/**
 * The flags on this surface that take no value.
 *
 * Needed because `--flag value` and a bare `--flag` cannot be told apart without knowing the flag:
 * the token after `--json` is a positional, the token after `--spec` is not.
 */
export const VALUELESS = new Set(["--json", "--help", "--check", "--clear-instructions", "--clear-completion", "--clear-return-stage", "--on", "--off"]);

/** A flag's value, in either spelling: `--name value` or `--name=value`. */
export function flag(args: string[], name: string): string | null {
  const joined = args.find((a) => a.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1) || null;
  const i = args.indexOf(name);
  if (i === -1) return null;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : null;
}

/**
 * Every value of a repeatable flag, in either spelling — `--label` may appear more than once
 * (`supi create-card <board> <title> --label lbl_a --label lbl_b`), and `flag` above only ever
 * reads the first occurrence.
 */
export function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name) {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) out.push(next);
      continue;
    }
    if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
  }
  return out;
}

/**
 * The positional arguments, with each flag and the value it consumed removed.
 *
 * Filtering on `startsWith("--")` alone keeps the value: `create-card <board> "A title" --spec
 * ./spec.json` read the path as part of the title. Every earlier verb read `pos[0]` only, so that
 * filter was correct by luck.
 */
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      out.push(a);
      continue;
    }
    // `--name=value` carries its own value; a bare flag that takes one eats the next token.
    if (!a.includes("=") && !VALUELESS.has(a) && args[i + 1] && !args[i + 1].startsWith("--")) i++;
  }
  return out;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `supi edit-card --merge-spec`: the given keys over the existing spec, one level deep.
 *
 * Shallow on purpose — a nested object in the merge REPLACES the one in the spec rather than being
 * merged into it, so what the person wrote is what that key becomes. A top-level `null` removes the
 * key, which is the only way to delete one without rewriting the whole spec.
 */
export function mergeSpec(existing: Record<string, unknown>, merge: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(merge)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}
