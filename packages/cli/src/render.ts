/**
 * Human-readable output, for a CLI that only ever emitted JSON.
 *
 * `out()` was `JSON.stringify(value, null, 2)` unconditionally, and `--json` changed exactly one
 * command's output (`whoami`) while the usage advertised it as "machine-stable output, on any
 * command". That phrasing promises a default which is something else, and there was none: reading
 * a card's state meant piping `supi board` through a filter, every time.
 *
 * Each renderer is a pure function of one response shape, so it is testable without a network and
 * without the CLI's `main`. A shape with no renderer still prints JSON — the fallback is in
 * `out()`, so adding a command never has to wait for its formatter.
 */
const PAD = "  ";

/** A shape from an API that may legitimately answer `{items: []}` or a bare array. */
function list<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  const inner = (value as Record<string, unknown> | null)?.[key];
  return Array.isArray(inner) ? (inner as T[]) : [];
}

/** `2026-09-28T17:45:30Z` → `17:45:30`. A log read in one sitting does not need the date. */
function clock(ts: unknown): string {
  return typeof ts === "string" && ts.length >= 19 ? ts.slice(11, 19) : "";
}

/** One line of prose from a value that may be a string, an object with a summary, or neither. */
function gist(value: unknown, width = 100): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "string"
      ? value
      : typeof (value as { summary?: unknown }).summary === "string"
        ? ((value as { summary: string }).summary)
        : JSON.stringify(value);
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

export function renderBoards(value: unknown): string {
  const boards = list<{ id?: string; name?: string }>(value, "boards");
  if (boards.length === 0) return "No boards. `supi create-board <name>` makes one.";
  return boards.map((b) => `${b.name ?? "(unnamed)"}\n${PAD}${b.id ?? ""}`).join("\n");
}

export function renderBoard(value: unknown): string {
  const b = (value ?? {}) as {
    name?: string;
    boardId?: string;
    stages?: { key: string; name: string; ownerKind?: string; owner?: string; gate?: string; instructions?: string }[];
    cards?: { id: string; title: string; currentStageKey?: string; state?: string }[];
    gates?: { cardId?: string; stageKey?: string }[];
  };
  const stages = [...(b.stages ?? [])];
  const cards = b.cards ?? [];
  const waiting = new Set((b.gates ?? []).map((g) => g.cardId));

  const lines = [`${b.name ?? "(unnamed)"}  ${b.boardId ?? ""}`.trim(), ""];
  for (const s of stages) {
    const worker = s.ownerKind === "capability" ? (s.owner ?? "?") : (s.ownerKind ?? "?");
    // A stage's standing rule appears in no UI and in no other command, so a board that does not
    // mention it leaves an operator no way to discover their agents are being told anything.
    const marks = [s.gate === "approval" ? "gate" : "", s.instructions ? "rule" : ""].filter(Boolean);
    lines.push(`${s.name}  [${worker}]${marks.length ? `  ${marks.join(" ")}` : ""}`);
    for (const c of cards.filter((c) => c.currentStageKey === s.key)) {
      lines.push(`${PAD}${c.title}  ${c.id}  ${c.state ?? ""}${waiting.has(c.id) ? "  ← waiting on you" : ""}`);
    }
  }
  return lines.join("\n");
}

export function renderGates(value: unknown): string {
  const gates = list<{ id?: string; cardId?: string; stageKey?: string; producedBy?: string; createdAt?: string }>(
    value,
    "gates",
  );
  if (gates.length === 0) return "No gates waiting.";
  return gates
    .map((g) =>
      [
        `${g.stageKey ?? "?"}  ${g.id ?? ""}`,
        `${PAD}card ${g.cardId ?? "?"}${g.producedBy ? `  produced by ${g.producedBy}` : ""}`,
        `${PAD}supi approve <boardId> ${g.id ?? "<gateId>"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * A workspace's projects (Task 18's `/v1/projects`, Task 20's `supi project list`). Each project
 * groups cards ACROSS boards, so there is no board to hang the listing off — name, state and
 * health are the whole row.
 */
export function renderProjects(value: unknown): string {
  const projects = list<{ id?: string; name?: string; state?: string; health?: string | null }>(value, "projects");
  if (projects.length === 0) return "No projects. `supi project add <name>` makes one.";
  return projects
    .map((p) => `${p.name ?? "(unnamed)"}  [${p.state ?? "?"}]${p.health ? `  ${p.health}` : ""}\n${PAD}${p.id ?? ""}`)
    .join("\n");
}

/**
 * One project and its milestones, exactly in the order the server sent them — `GET
 * /v1/projects/:id` already answers `sort_order ASC, name ASC` (`db/projects.ts`
 * `listMilestones`), so this renderer does not re-sort; doing so would risk silently disagreeing
 * with the one place `sortOrder` is actually enforced.
 */
export function renderProject(value: unknown): string {
  const v = (value ?? {}) as {
    project?: { id?: string; name?: string; state?: string; health?: string | null; targetDate?: string | null; description?: string | null };
    milestones?: { id?: string; name?: string; targetDate?: string | null }[];
  };
  const p = v.project ?? {};
  const milestones = v.milestones ?? [];
  const lines = [
    `${p.name ?? "(unnamed)"}  ${p.id ?? ""}`.trim(),
    `state ${p.state ?? "?"}${p.health ? `  health ${p.health}` : ""}${p.targetDate ? `  target ${p.targetDate}` : ""}`,
  ];
  if (p.description) lines.push("", p.description);
  lines.push("", milestones.length === 0 ? "No milestones." : "Milestones");
  for (const m of milestones) {
    lines.push(`${PAD}${m.name ?? "(unnamed)"}${m.targetDate ? `  ${m.targetDate}` : ""}  ${m.id ?? ""}`);
  }
  return lines.join("\n");
}

/** A handoff as written: a plain string, an object with a `summary`, or a JSON fallback. */
function handoffText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  const summary = (value as { summary?: unknown }).summary;
  if (typeof summary === "string") return summary.trim();
  return JSON.stringify(value, null, 2);
}

export function renderLog(value: unknown): string {
  const v = (value ?? {}) as { activities?: unknown[]; handoff?: unknown };
  const acts = (v.activities ?? []) as { type?: string; ts?: string; action?: string; result?: string; body?: unknown }[];
  const lines: string[] = [];
  for (const a of acts) {
    const what = a.action ?? gist(a.body);
    if (!what) continue;
    lines.push(`${clock(a.ts)}  ${(a.type ?? "").padEnd(8)}  ${what}${a.result ? `  (${a.result})` : ""}`);
  }
  if (lines.length === 0) lines.push("No activity recorded for this card.");

  // The handoff keeps its own line breaks. Activities are an index and each belongs on one line;
  // the handoff is prose an agent wrote, and flattened it buries the URL and the commit sha it
  // exists to report in the middle of a paragraph.
  const handoff = handoffText(v.handoff);
  if (handoff) {
    lines.push("", "Handoff");
    for (const line of handoff.split("\n")) lines.push(line ? `${PAD}${line}` : "");
  }
  return lines.join("\n");
}

/**
 * A card's comment thread, oldest first. Each body keeps its own line breaks, indented under its
 * author — a comment is prose a person wrote, and flattening it would bury a list or a pasted
 * command. It is printed as the text it is; nothing in it is interpreted.
 */
export function renderComments(value: unknown): string {
  const comments = list<{
    author?: { kind?: string; id?: string; name?: string | null };
    body?: string;
    createdAt?: string;
    deletedAt?: string | null;
  }>(value, "comments");
  if (comments.length === 0) return "No comments on this card. `supi comment <boardId> <cardId> <text>` adds one.";
  const blocks: string[] = [];
  for (const c of comments) {
    const who = `${c.author?.name || c.author?.id || "?"} (${c.author?.kind === "agent" ? "agent" : "person"})`;
    const when = typeof c.createdAt === "string" ? c.createdAt.slice(0, 16).replace("T", " ") : "";
    if (c.deletedAt) {
      blocks.push(`${when}  ${who}  (deleted)`);
      continue;
    }
    const body = (c.body ?? "").split("\n").map((l) => (l ? `${PAD}${l}` : "")).join("\n");
    blocks.push(`${when}  ${who}\n${body}`);
  }
  return blocks.join("\n\n");
}
