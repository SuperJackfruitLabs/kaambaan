/**
 * The command table, held to the switch it describes and to the pages generated from it.
 *
 * Three ways the reference goes wrong, each with its own assertion:
 *
 *   1. a verb, sub-verb or flag is handled in `index.ts` and has no entry in `commands.ts` — it
 *      works and nobody can find it (four `set-stage` flags were in this state when this was written);
 *   2. an entry names something the switch never reads — a documented command that does nothing;
 *   3. the committed pages under `docs-site/` are not what `reference.ts` renders today.
 *
 * Read from the source rather than by running the CLI, for the reason `verbs.test.ts` gives:
 * `index.ts` ends in `await main(...)`, so importing it would run it.
 *
 * To regenerate the pages after changing a command: `pnpm -F @superpipeline/cli reference`.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMMANDS, ENV_VARS, GLOBAL_FLAGS, GROUPS, findCommands, renderCommandHelp, renderUsage } from "./commands.ts";
import { REFERENCE_DIR, renderReference } from "./reference.ts";
import { VALUELESS } from "./args.ts";

const SRC = import.meta.dirname;
const REPO = join(SRC, "..", "..", "..");
const CONTENT = join(REPO, "docs-site", "src", "content", "docs");
const source = readFileSync(join(SRC, "index.ts"), "utf8");

/**
 * Each `case` arm of main's switch: the verbs it answers (fall-through cases share one body), and
 * the sub-verbs and flags its body reads.
 */
function arms(): Array<{ verbs: string[]; subs: Set<string>; flags: Set<string> }> {
  const start = source.indexOf("  switch (cmd) {");
  const end = source.indexOf("    default:", start);
  expect(start, "main's switch was not found").toBeGreaterThan(0);
  const body = source.slice(start, end);
  const out: Array<{ verbs: string[]; subs: Set<string>; flags: Set<string> }> = [];
  // Split on runs of consecutive `case` labels; each run owns the text up to the next run.
  const labelRun = /((?:^ {4}case [^\n]+:[^\n]*\n)+)/gm;
  const runs = [...body.matchAll(labelRun)];
  runs.forEach((m, i) => {
    const verbs = [...m[1]!.matchAll(/case "([^"]+)":/g)].map((x) => x[1]!);
    const text = body.slice(m.index! + m[0].length, i + 1 < runs.length ? runs[i + 1]!.index : body.length);
    const subs = new Set([...text.matchAll(/\bsub [!=]== "([a-z-]+)"/g)].map((x) => x[1]!));
    const flags = new Set(
      [...text.matchAll(/(?:\bflags?\(rest, |rest\.includes\()"(--[a-z-]+)"/g)].map((x) => x[1]!),
    );
    out.push({ verbs, subs, flags });
  });
  return out;
}

/** Verbs that print the summary rather than name a thing the CLI does. */
const HELP_ALIASES = new Set(["-h", "--help"]);

describe("the command table matches the switch", () => {
  it("parses the switch at all — a guard on the guard", () => {
    // An empty parse passes every comparison below for free.
    const verbs = arms().flatMap((a) => a.verbs);
    expect(verbs.length).toBeGreaterThan(25);
    expect(verbs).toContain("create-card");
    expect(arms().find((a) => a.verbs.includes("set-stage"))!.flags).toContain("--wip");
    expect(arms().find((a) => a.verbs.includes("schedule"))!.subs).toContain("pause");
  });

  it("has an entry for every verb and sub-verb the switch dispatches, and no other", () => {
    const dispatched = new Set<string>();
    for (const arm of arms()) {
      for (const verb of arm.verbs) {
        if (HELP_ALIASES.has(verb)) continue;
        if (arm.subs.size === 0) dispatched.add(verb);
        for (const sub of arm.subs) dispatched.add(`${verb} ${sub}`);
      }
    }
    const documented = new Set(COMMANDS.map((c) => c.path.join(" ")));
    expect([...dispatched].filter((v) => !documented.has(v)), "dispatched, with no entry in commands.ts").toEqual([]);
    expect([...documented].filter((v) => !dispatched.has(v)), "in commands.ts, dispatched nowhere").toEqual([]);
  });

  it("documents exactly the flags each verb reads", () => {
    const global = new Set(GLOBAL_FLAGS.map((f) => f.name));
    for (const arm of arms()) {
      for (const verb of arm.verbs) {
        if (HELP_ALIASES.has(verb)) continue;
        const read = [...arm.flags].filter((f) => !global.has(f)).sort();
        const documented = [...new Set(COMMANDS.filter((c) => c.path[0] === verb).flatMap((c) => c.flags.map((f) => f.name)))].sort();
        expect(documented, `supi ${verb}: flags in commands.ts vs flags index.ts reads`).toEqual(read);
      }
    }
  });

  it("treats every boolean flag as taking no value, and nothing else", () => {
    // `positionals` must know which flags consume the next token. A boolean missing from
    // VALUELESS eats the argument after it: `supi board --help brd_x` would lose the board id.
    const booleans = new Set([...GLOBAL_FLAGS, ...COMMANDS.flatMap((c) => c.flags)].filter((f) => f.type === "boolean").map((f) => f.name));
    expect([...VALUELESS].sort()).toEqual([...booleans].sort());
  });

  it("gives every command a summary, a description, an example and an access entry", () => {
    for (const c of COMMANDS) {
      const name = c.path.join(" ");
      expect(c.summary.length, `${name}: summary`).toBeGreaterThan(5);
      expect(c.description.length, `${name}: description`).toBeGreaterThan(20);
      expect(c.examples.length, `${name}: example`).toBeGreaterThan(0);
      for (const e of c.examples) expect(e, `${name}: example`).toContain("supi ");
      // A command that calls the server has to say who may.
      if (c.routes.some((r) => r.path.startsWith("/v1/"))) expect(c.access.role, `${name}: role`).not.toBeNull();
      for (const f of c.flags) expect(f.description.length, `${name} ${f.name}: description`).toBeGreaterThan(5);
      expect(GROUPS.some((g) => g.id === c.group), `${name}: group`).toBe(true);
    }
  });

  it("renders help for every command, reachable by its own words", () => {
    for (const c of COMMANDS) {
      expect(findCommands(c.path)).toContain(c);
      expect(renderCommandHelp(c)).toContain(`supi ${c.path.join(" ")}`);
    }
    const usage = renderUsage();
    for (const c of COMMANDS) expect(usage, `usage lists supi ${c.path.join(" ")}`).toContain(`supi ${c.path.join(" ")}`);
  });
});

describe("the environment the CLI reads", () => {
  /** Names `supi` reads: the `ENV_*` constants, and any literal `process.env.NAME`. */
  function readByCli(): Set<string> {
    const names = new Set<string>();
    for (const f of readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const text = readFileSync(join(SRC, f), "utf8");
      for (const m of text.matchAll(/export const ENV_[A-Z_]+ = "([A-Z_]+)"/g)) names.add(m[1]!);
      for (const m of text.matchAll(/process\.env\.([A-Z_]+)/g)) names.add(m[1]!);
    }
    return names;
  }

  /** Names the release installer takes from its caller: `${NAME:-…}`. */
  function readByInstaller(): Set<string> {
    const text = readFileSync(join(REPO, "scripts", "install.sh"), "utf8");
    return new Set([...text.matchAll(/\$\{([A-Z_]+):-/g)].map((m) => m[1]!));
  }

  it("documents every variable, and only those", () => {
    expect(readByCli().size).toBeGreaterThan(4);
    expect(ENV_VARS.filter((e) => !e.installer).map((e) => e.name).sort()).toEqual([...readByCli()].sort());
    expect(ENV_VARS.filter((e) => e.installer).map((e) => e.name).sort()).toEqual([...readByInstaller()].sort());
  });
});

describe("the published reference", () => {
  const pages = renderReference();
  const dir = join(CONTENT, REFERENCE_DIR);

  // Opt-in rewrite, so the same file is the generator and the guard: `pnpm -F @superpipeline/cli reference`.
  if (process.env.UPDATE_REFERENCE === "1") {
    rmSync(dir, { recursive: true, force: true });
    for (const [rel, text] of pages) {
      mkdirSync(dirname(join(CONTENT, rel)), { recursive: true });
      writeFileSync(join(CONTENT, rel), text);
    }
  }

  it("covers every command, under its own heading", () => {
    const all = [...pages.values()].join("\n");
    for (const c of COMMANDS) expect(all, `no heading for supi ${c.path.join(" ")}`).toContain(`## \`supi ${c.path.join(" ")}\``);
    for (const e of ENV_VARS) expect(all).toContain(`\`${e.name}\``);
  });

  it("is committed exactly as the generator writes it", () => {
    for (const [rel, text] of pages) {
      const path = join(CONTENT, rel);
      expect(existsSync(path), `${rel} is missing — run pnpm -F @superpipeline/cli reference`).toBe(true);
      expect(readFileSync(path, "utf8"), `${rel} is stale — run pnpm -F @superpipeline/cli reference`).toBe(text);
    }
  });

  it("holds no page the generator does not write", () => {
    // A command removed from the table must not leave its page behind, still published.
    const committed = readdirSync(dir).map((f) => `${REFERENCE_DIR}/${f}`);
    expect(committed.filter((f) => !pages.has(f))).toEqual([]);
  });
});
