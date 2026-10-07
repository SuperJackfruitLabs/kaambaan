/**
 * The published `supi` reference, generated from `commands.ts`.
 *
 * The output is committed under `docs-site/src/content/docs/reference/cli/` — the docs site is a
 * separate npm project and cannot import this package — and `reference.test.ts` fails when the
 * committed pages differ from what this renders. To regenerate after changing a command:
 *
 *     pnpm -F @superpipeline/cli reference
 */
import {
  COMMANDS,
  ENV_VARS,
  GLOBAL_FLAGS,
  GROUPS,
  ROLE_TEXT,
  commandName,
  synopsis,
  type Access,
  type CommandSpec,
  type FlagSpec,
} from "./commands.ts";

/** Where the pages land, relative to the docs site's content root. */
export const REFERENCE_DIR = "reference/cli";

const GENERATED =
  "<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->";

/** A table cell: pipes escaped (GFM honours `\|` inside code spans too), newlines flattened. */
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ");

/** The heading anchor Starlight gives `## \`supi link add\``. */
export function anchor(c: CommandSpec): string {
  return commandName(c).replace(/ /g, "-");
}

function pageFor(c: CommandSpec): string {
  return `/${REFERENCE_DIR}/${c.group}/`;
}

function frontmatter(title: string, description: string, label: string, order: number): string {
  // YAML double-quoted strings: escape the two characters that need it.
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return ["---", `title: ${q(title)}`, `description: ${q(description)}`, "sidebar:", `  label: ${q(label)}`, `  order: ${order}`, "---"].join("\n");
}

function flagType(f: FlagSpec): string {
  if (f.type === "enum" && f.choices) return `one of ${f.choices.map((c) => `\`${c}\``).join(", ")}`;
  if (f.type === "path") return "file path, or `-` for stdin";
  if (f.type === "date") return "date, `YYYY-MM-DD`";
  if (f.type === "list") return "comma-separated list";
  return f.type;
}

function flagTable(flags: FlagSpec[]): string[] {
  const rows = flags.map((f) => {
    const name = `\`${f.value ? `${f.name} ${f.value}` : f.name}\``;
    const dflt = f.required ? "**required**" : f.default ?? "—";
    const meaning = f.description + (f.repeatable ? ". Repeatable" : "");
    return `| ${cell(name)} | ${cell(flagType(f))} | ${cell(dflt)} | ${cell(meaning)} |`;
  });
  return ["| flag | type | default | meaning |", "|---|---|---|---|", ...rows];
}

function accessText(a: Access): string[] {
  if (a.role === null && a.agent === null) {
    return [a.note ? `Local. ${a.note}` : "Local: sends no credential to superpipeline."];
  }
  const out: string[] = [];
  if (a.role) out.push(`- **A person:** ${ROLE_TEXT[a.role]} in the workspace.`);
  if (a.agent === "any") out.push("- **An agent token:** any; no scope is checked.");
  else if (a.agent === "refused") out.push("- **An agent token:** refused, whatever scopes it carries.");
  else if (a.agent) out.push(`- **An agent token:** the \`${a.agent}\` scope.`);
  if (a.note) out.push("", a.note);
  return out;
}

function renderCommand(c: CommandSpec): string[] {
  const out: string[] = [`## \`${commandName(c)}\``, "", c.description, "", "```sh", synopsis(c), "```", ""];
  if (c.args.length > 0) {
    out.push("| argument | meaning |", "|---|---|");
    for (const a of c.args) {
      const extra = [a.optional ? "optional" : "", a.rest ? "takes every remaining word" : ""].filter((s) => s !== "").join("; ");
      out.push(`| ${cell(`\`<${a.name}>\``)} | ${cell(a.description + (extra ? ` (${extra})` : ""))} |`);
    }
    out.push("");
  }
  if (c.flags.length > 0) out.push(...flagTable(c.flags), "");
  out.push("**Who may run it**", "", ...accessText(c.access), "");
  if (c.routes.length > 0) {
    out.push(`**Calls** ${c.routes.map((r) => `\`${r.method} ${r.path}\``).join(", then ")}`, "");
  }
  out.push(`**Prints** ${c.output}.`, "");
  out.push("**Exit status** `0` on success. `1` when:", "");
  const fails = [...c.fails];
  if (c.routes.some((r) => r.path.startsWith("/v1/"))) {
    fails.push("there is no usable credential, or the server refuses it (401) or the act (403), or answers any other error");
  }
  if (fails.length === 0) fails.push("it cannot write its output (never in normal use)");
  for (const f of fails) out.push(`- ${f}`);
  out.push("", "**Example**", "", "```sh", ...c.examples, "```", "");
  return out;
}

function renderGroupPage(groupIndex: number): string {
  const g = GROUPS[groupIndex]!;
  const cmds = COMMANDS.filter((c) => c.group === g.id);
  const lines: string[] = [
    frontmatter(g.title, g.description, g.label, groupIndex + 2),
    "",
    GENERATED,
    "",
    g.intro,
    "",
    "Every command here also takes `--json` and `--help` — see [the overview](/reference/cli/).",
    "",
  ];
  for (const c of cmds) lines.push(...renderCommand(c));
  return lines.join("\n").replace(/\n+$/, "\n");
}

function renderIndex(): string {
  const lines: string[] = [
    frontmatter(
      "supi command reference",
      "Every supi command, flag and environment variable, generated from the CLI's own command table.",
      "Overview",
      1,
    ),
    "",
    GENERATED,
    "",
    "`supi` is superpipeline from a terminal; `superpipeline` is the same program under its full name. " +
      "These pages are generated from the table the CLI's own `supi help` is printed from, so the two cannot " +
      "disagree. For a guided tour rather than a reference, see [From the terminal](/use/cli/).",
    "",
    "```sh",
    "supi <verb> [<sub-verb>] [<arguments>] [--flags] [--json]",
    "supi help <verb> [<sub-verb>]",
    "```",
    "",
    "The verb comes first. Flags may be written `--name value` or `--name=value`, anywhere after the verb, " +
      "before or after the positional arguments. A value that itself starts with `--` must use the `=` form.",
    "",
    "## Commands",
    "",
  ];
  for (const g of GROUPS) {
    lines.push(`### ${g.title}`, "", "| command | what it does |", "|---|---|");
    for (const c of COMMANDS.filter((x) => x.group === g.id)) {
      lines.push(`| [\`${cell(commandName(c))}\`](${pageFor(c)}#${anchor(c)}) | ${cell(c.summary)} |`);
    }
    lines.push("");
  }
  lines.push("## Flags every command takes", "", ...flagTable(GLOBAL_FLAGS), "");
  lines.push(
    "## Signing in",
    "",
    "A person signs in once with `supi login`. It finds the server's sign-in service from the server itself " +
      "(`/.well-known/oauth-protected-resource`) — for app.superpipeline.dev that is " +
      "**https://accounts.superjackfruit.com**, the same account you use in the web app — and runs its device flow: " +
      "open the printed link, confirm the code, and `supi` keeps a device credential of its own. Every command " +
      "after that exchanges it for a token that lives minutes, without a browser.",
    "",
    "The credential a command acts with is the first of these that exists:",
    "",
    "1. `$SUPERPIPELINE_AGENT_TOKEN_FILE` — an agent; the file is re-read on every run",
    "2. `$SUPERPIPELINE_AGENT_TOKEN` — an agent",
    "3. `$SUPERPIPELINE_TOKEN` — a person's token, used exactly as supplied",
    "4. `$AGENTPOD_TOKEN` — a person's hub token, used exactly as supplied",
    "5. `supi login`'s cached token, while it is fresh",
    "6. `supi login`'s device credential, exchanged at the sign-in service recorded at login",
    "7. the token AgentPod's `fleet login` cached — skipped when it was issued for a different audience, which " +
      "is the case once a server has moved to the sign-in service",
    "8. `fleet login`'s device credential — exchanged at the sign-in service it recorded for this server's " +
      "audience (and cached in supi's own directory, never in fleet's), or, for a server not yet on the sign-in " +
      "service, renewed at the hub it recorded",
    "",
    "Steps 7 and 8 exist so a machine already signed in with `fleet login` needs no second sign-in. " +
      "Environment tokens are never renewed and never silently swapped for a file on disk: when one expires, " +
      "replace or unset it. An agent credential is never renewed either, and a person's token in an agent slot " +
      "(or an `spa_` token in a person's slot) is refused rather than used.",
    "",
    "Credentials live under the platform config directory — `$XDG_CONFIG_HOME` (or `~/.config`) on Linux, " +
      "`~/Library/Application Support` on macOS, `%APPDATA%` on Windows — in `superpipeline/device.json` and " +
      "`superpipeline/token.json` for `supi login`, and `superpipeline/fleet-token.json` for a token exchanged from " +
      "fleet's device. They are written atomically with mode 0600. A device credential is sent only to the " +
      "service it was issued by, over HTTPS (plain HTTP only on loopback), with redirects disabled.",
    "",
    "## Environment",
    "",
    "| variable | read by | meaning |",
    "|---|---|---|",
    ...ENV_VARS.map((e) => `| \`${e.name}\` | ${e.installer ? "the installer" : "`supi`"} | ${cell(e.description)} |`),
    "",
    "## Who may run what",
    "",
    "`supi` adds no authority and checks no permission itself: the server decides, and a refusal is printed " +
      "as it arrives. Each command's page lists what the server asks for, two ways:",
    "",
    "- **A person** needs a workspace role: `viewer` < `member` < `admin` < `owner`, each including the ones " +
      "before it. See [People and roles](/use/people/).",
    "- **An agent token** needs a scope — `read`, `queue`, `plan` or `compose` for a coordinator. An `spa_` token " +
      "reads and plans; only an agent JWT (a station token) carries the dispatch grant that queues work. Deciding a " +
      "gate is refused to every agent token. See [Authentication](/build/auth/#scopes).",
    "",
    "## Exit status and errors",
    "",
    "`0` when the command did what it says; `1` for everything else — a usage error, a missing or expired " +
      "credential, a refusal, a server error, a network failure. The message goes to standard error, followed by " +
      "a hint where there is one. Output goes to standard output, so `--json` output can be piped safely.",
    "",
    "- **401** means sign in: `supi login`.",
    "- **403** means your role or your token's scopes do not permit this. The two are never conflated, because " +
      "telling somebody to sign in again when the answer is \"you may not\" sends them round a loop.",
    "",
  );
  return lines.join("\n").replace(/\n+$/, "\n");
}

/** Every page, keyed by its path under `docs-site/src/content/docs/`. */
export function renderReference(): Map<string, string> {
  const pages = new Map<string, string>();
  pages.set(`${REFERENCE_DIR}/index.md`, renderIndex());
  GROUPS.forEach((g, i) => pages.set(`${REFERENCE_DIR}/${g.id}.md`, renderGroupPage(i)));
  return pages;
}
