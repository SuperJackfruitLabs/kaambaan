import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderComments } from "./render.ts";

/**
 * `supi comment` and `supi comments`: posting to and reading a card's comment thread.
 *
 * Same harness as `edit-card.test.ts`: a mocked `fetch` and `process.argv`, so what is held here is
 * the request each verb sends and what it prints. Who may post is the server's decision.
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
const URL_ = "https://work.example/v1/boards/brd_1/cards/crd_1/comments";
const COMMENT = {
  id: "cmt_1",
  cardId: "crd_1",
  author: { kind: "human", id: "usr_a", name: "Asha" },
  body: "Please cover the expired-token path.",
  createdAt: "2026-10-08T10:00:00.000Z",
  deletedAt: null,
};

describe("supi comment", () => {
  it("POSTs every remaining word as the body, so a sentence needs no quoting", async () => {
    fetchMock.mockResolvedValueOnce(json({ comment: COMMENT }, 201));
    expect(await run(["comment", "brd_1", "crd_1", "Please", "cover", "the", "expired-token", "path."])).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(URL_);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ body: "Please cover the expired-token path." });
  });

  it("reads the body from stdin with -, keeping its line breaks", async () => {
    vi.doMock("node:fs", async (original) => {
      const real = await original<typeof import("node:fs")>();
      return { ...real, readFileSync: ((p: unknown, ...r: unknown[]) => (p === 0 ? "line one\n\n- a bullet\n" : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...r))) as typeof real.readFileSync };
    });
    fetchMock.mockResolvedValueOnce(json({ comment: COMMENT }, 201));
    await run(["comment", "brd_1", "crd_1", "-"]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).toEqual({ body: "line one\n\n- a bullet" });
  });

  it("refuses an empty comment and missing ids before sending anything", async () => {
    expect(await run(["comment", "brd_1", "crd_1"])).toBe(1);
    expect(await run(["comment", "brd_1"])).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("supi comments", () => {
  it("GETs the thread and prints it readably", async () => {
    fetchMock.mockResolvedValueOnce(json({ comments: [COMMENT] }));
    expect(await run(["comments", "brd_1", "crd_1"])).toBe(0);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(URL_);
    const text = stdout.join("");
    expect(text).toContain("Asha");
    expect(text).toContain("Please cover the expired-token path.");
  });
});

describe("renderComments", () => {
  it("names the author and their kind, keeps line breaks, and shows a deleted comment as deleted", () => {
    const text = renderComments({
      comments: [
        { ...COMMENT, body: "two\nlines" },
        { ...COMMENT, id: "cmt_2", author: { kind: "agent", id: "agt_b", name: "Builder" }, body: "done" },
        { ...COMMENT, id: "cmt_3", body: "", deletedAt: "2026-10-08T11:00:00.000Z" },
      ],
    });
    expect(text).toContain("Asha (person)");
    expect(text).toContain("Builder (agent)");
    expect(text).toContain("  two\n  lines");
    expect(text).toContain("(deleted)");
  });

  it("says so when there are none", () => {
    expect(renderComments({ comments: [] })).toContain("No comments");
  });
});
