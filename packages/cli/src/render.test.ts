/**
 * The human-readable rendering this CLI does when `--json` is absent.
 *
 * Until now `out()` was `JSON.stringify` unconditionally and `--json` changed the output of
 * exactly one command (`whoami`), while the usage advertised it as "machine-stable output, on any
 * command" — which promises a default that is something else. These hold the default to being
 * something a person can read, and hold the JSON to being reachable on demand.
 */
import { describe, expect, it } from "vitest";
import { renderBoards, renderBoard, renderGates, renderLog } from "./render";

describe("boards", () => {
  it("lists a board's id beside its name", () => {
    const text = renderBoards({ boards: [{ id: "brd_1", name: "Press" }] });
    expect(text).toContain("Press");
    expect(text).toContain("brd_1");
  });

  it("says so plainly when there are none, rather than printing an empty frame", () => {
    expect(renderBoards({ boards: [] }).toLowerCase()).toContain("no boards");
  });
});

describe("a board", () => {
  const board = {
    boardId: "brd_1",
    name: "Press",
    stages: [
      { key: "brief", name: "Brief", order: 1, ownerKind: "capability", owner: "research", instructions: "x" },
      { key: "angle", name: "Angle approved", order: 2, ownerKind: "human", gate: "approval" },
    ],
    cards: [{ id: "card_9", title: "A post", currentStageKey: "brief", state: "working" }],
    gates: [],
  };

  it("shows stages in pipeline order, with who works each one", () => {
    const text = renderBoard(board);
    expect(text.indexOf("Brief")).toBeLessThan(text.indexOf("Angle approved"));
    expect(text).toContain("research");
  });

  it("puts each card under the stage holding it", () => {
    const lines = renderBoard(board).split("\n");
    const brief = lines.findIndex((l) => l.includes("Brief"));
    const card = lines.findIndex((l) => l.includes("A post"));
    expect(brief).toBeGreaterThanOrEqual(0);
    expect(card).toBeGreaterThan(brief);
  });

  it("marks a stage that carries a standing rule, because nothing else reveals one", () => {
    // `stage.instructions` is in no UI and no other command. A board view that omits it leaves
    // the operator no way to discover that a stage tells its agent anything at all.
    expect(renderBoard(board)).toMatch(/rule/i);
  });

  it("does not claim a rule on a stage that has none", () => {
    const bare = { ...board, stages: [{ ...board.stages[0], instructions: undefined }] };
    expect(renderBoard(bare)).not.toMatch(/rule/i);
  });
});

describe("gates", () => {
  it("names the gate id to decide with, not just the stage", () => {
    const text = renderGates({
      gates: [{ id: "gate_7", cardId: "card_9", stageKey: "angle", status: "pending", producedBy: "agt_1" }],
    });
    expect(text).toContain("gate_7");
    expect(text).toContain("angle");
  });

  it("says nothing is waiting rather than printing a header over emptiness", () => {
    expect(renderGates({ gates: [] }).toLowerCase()).toMatch(/no gates|nothing/);
  });
});

describe("a card's log", () => {
  const log = {
    activities: [
      { seq: 1, type: "action", ts: "2026-09-28T17:45:30Z", action: "read_file: brief.md", result: "completed" },
      { seq: 2, type: "response", ts: "2026-09-28T17:50:41Z", body: "Completed the research stage." },
    ],
    handoff: { summary: "Wrote the brief." },
    gates: [],
  };

  it("shows what the agent did, oldest first", () => {
    const text = renderLog(log);
    expect(text.indexOf("read_file")).toBeLessThan(text.indexOf("Completed the research stage"));
  });

  it("shows the handoff, which is the stage's actual output", () => {
    expect(renderLog(log)).toContain("Wrote the brief.");
  });

  it("keeps the handoff's own lines, because it is the part worth reading", () => {
    // Collapsed to one line, a markdown handoff — which is what agents write — becomes a wall
    // with its URL and commit sha buried mid-sentence. The activity lines are a scannable index
    // and belong on one line each; the handoff is prose and does not.
    const text = renderLog({
      activities: [],
      handoff: { summary: "## Published\n\n- URL: https://example.test/x\n- Commit: abc1234" },
      gates: [],
    });
    expect(text).toContain("- URL: https://example.test/x");
    expect(text.split("\n").filter((l) => l.includes("Commit: abc1234"))).toHaveLength(1);
    expect(text).not.toContain("## Published - URL");
  });

  it("survives an empty log without throwing", () => {
    expect(() => renderLog({ activities: [], handoff: null, gates: [] })).not.toThrow();
  });
});
