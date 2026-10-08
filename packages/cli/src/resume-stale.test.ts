import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderStale } from "./render.ts";

/**
 * `supi resume`, `supi stale` and `supi set-stale`: the human half of a block, and finding the cards
 * that need one.
 *
 * Same harness as `comment.test.ts`: a mocked `fetch` and `process.argv`, so what is held here is the
 * request each verb sends and what it prints. Who may resume is the server's decision.
 */
const fetchMock = vi.fn<typeof fetch>();
const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ sub: "human", principalKind: "human", exp })).toString("base64url")}.sig`;
let stdout: string[];
let stderr: string[];

class ExitSignal extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.stubEnv("SUPERPIPELINE_TOKEN", jwt(Math.floor(Date.now() / 1000) + 300));
  vi.stubEnv("AGENTPOD_TOKEN", "");
  vi.stubEnv("SUPERPIPELINE_URL", "https://work.example");
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => (stdout.push(String(s)), true)) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => (stderr.push(String(s)), true)) as never);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("node:fs");
});

async function run(argv: string[]): Promise<number | undefined> {
  vi.resetModules();
  vi.spyOn(process, "argv", "get").mockReturnValue(["bun", "supi", ...argv]);
  try {
    await import("./index");
  } catch (e) {
    if (e instanceof ExitSignal) return e.code;
    throw e;
  }
  return 0;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const STALE = {
  boardId: "brd_1",
  boardName: "Releases",
  cardId: "crd_1",
  title: "Write the notes",
  ownerUserId: "usr_a",
  stageKey: "build",
  stageName: "Build",
  state: "input-required",
  why: { kind: "needs-human", reason: "blocked", detail: "the staging database is down" },
  summary: null,
  since: "2026-10-06T10:00:00.000Z",
  ageHours: 50.2,
  next: 'read why it stopped, fix that, then resume it: supi resume brd_1 crd_1 --comment "what changed"',
};

describe("supi resume", () => {
  it("POSTs the comment, and the stage when one is named", async () => {
    fetchMock.mockImplementation(async () => json({ card: { id: "crd_1" }, comment: { id: "cmt_1" } }));
    expect(await run(["resume", "brd_1", "crd_1", "--comment", "Staging is back"])).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://work.example/v1/boards/brd_1/cards/crd_1/resume");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ comment: "Staging is back" });

    await run(["resume", "brd_1", "crd_1", "--stage", "plan", "--comment=Re-plan it"]);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]?.body as string)).toEqual({ comment: "Re-plan it", toStageKey: "plan" });
  });

  it("refuses to resume without a comment — the comment is what the next agent reads", async () => {
    expect(await run(["resume", "brd_1", "crd_1"])).toBe(1);
    expect(await run(["resume", "brd_1", "--comment", "x"])).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stderr.join("")).toContain("--comment");
  });
});

describe("supi stale", () => {
  it("GETs the workspace list, with the threshold when given, and prints it readably", async () => {
    fetchMock.mockImplementation(async () => json({ cards: [STALE], boardsUnanswered: 0 }));
    expect(await run(["stale"])).toBe(0);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://work.example/v1/stale");
    const text = stdout.join("");
    expect(text).toContain("Releases");
    expect(text).toContain("Write the notes");
    expect(text).toContain("the staging database is down");
    expect(text).toContain("supi resume brd_1 crd_1");

    await run(["stale", "--hours", "2"]);
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://work.example/v1/stale?hours=2");
  });

  it("refuses a threshold that is not a number of hours", async () => {
    expect(await run(["stale", "--hours", "soon"])).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("supi set-stale", () => {
  it("PUTs the threshold and the switch", async () => {
    fetchMock.mockImplementation(async () => json({ stale: { enabled: false, afterHours: 48 } }));
    expect(await run(["set-stale", "brd_1", "--hours", "48", "--off"])).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://work.example/v1/boards/brd_1/stale");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual({ afterHours: 48, enabled: false });
    await run(["set-stale", "brd_1", "--on"]);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]?.body as string)).toEqual({ enabled: true });
  });

  it("refuses nothing to set, and --on with --off", async () => {
    expect(await run(["set-stale", "brd_1"])).toBe(1);
    expect(await run(["set-stale", "brd_1", "--on", "--off"])).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("renderStale", () => {
  it("says why each card is stuck and what to do, and names a stage nothing claims", () => {
    const text = renderStale({
      cards: [STALE, { ...STALE, cardId: "crd_2", stageKey: "requested", stageName: "Requested", state: "submitted", why: { kind: "no-owner" }, next: "move it" }],
      boardsUnanswered: 1,
    });
    expect(text).toContain("blocked: the staging database is down");
    expect(text).toContain('nothing claims stage "requested"');
    expect(text).toContain("50h");
    expect(text).toContain("1 board did not answer");
  });

  it("says so when nothing is stuck", () => {
    expect(renderStale({ cards: [], boardsUnanswered: 0 })).toContain("Nothing is stuck");
  });
});
