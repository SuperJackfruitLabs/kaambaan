import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `supi link add|rm|list` and `supi archive` — the CLI's client for Task 17a's link routes
 * (`POST|DELETE /v1/boards/:id/links`, `GET /v1/boards/:id/cards/:cardId/links`) and the
 * `archivedAt` patch the card route has validated since Phase 1 (`index.ts:1325-1342`).
 *
 * Modelled on `schedule.test.ts`: a real token in the environment, a mocked `fetch`, and a dynamic
 * import of `./index` with `process.argv` stubbed — so this checks the REQUEST each verb sends,
 * not just that the switch dispatches.
 */
const fetchMock = vi.fn<typeof fetch>();
const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ sub: "human", principalKind: "human", exp })).toString("base64url")}.sig`;
const fresh = () => jwt(Math.floor(Date.now() / 1000) + 300);
let token: string;

/** `fail()` writes to stderr and calls `process.exit(1)` — mocked to throw so a usage error can be caught rather than killing the test runner. */
class ExitSignal extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  token = fresh();
  vi.stubEnv("SUPERPIPELINE_TOKEN", token);
  vi.stubEnv("AGENTPOD_TOKEN", "");
  vi.stubEnv("SUPERPIPELINE_URL", "https://work.example");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function run(argv: string[]): Promise<void> {
  vi.spyOn(process, "argv", "get").mockReturnValue(["bun", "supi", ...argv]);
  await import("./index");
}

describe("supi link add", () => {
  it("POSTs fromCardId/toCardId/kind to the board's links route", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ link: {} }), { status: 201 }));

    await run(["link", "add", "brd_1", "card_a", "card_b", "--kind", "blocks"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/boards/brd_1/links");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ fromCardId: "card_a", toCardId: "card_b", kind: "blocks" });
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  });

  it("accepts relates and parent too", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ link: {} }), { status: 201 }));

    await run(["link", "add", "brd_1", "card_a", "card_b", "--kind", "parent"]);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toMatchObject({ kind: "parent" });
  });

  it("rejects an unknown --kind without sending a request", async () => {
    await expect(run(["link", "add", "brd_1", "card_a", "card_b", "--kind", "nonsense"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing --kind without sending a request", async () => {
    await expect(run(["link", "add", "brd_1", "card_a", "card_b"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * Task 17d: `--to-board` rides the same route Task 17a built, defaulting to the path board. When
 * it names a DIFFERENT board, the edge is advisory (Task 16's D1 store) rather than enforced (the
 * DO) — and the CLI has to say so BEFORE sending the request, not after, or a person who asked for
 * a blocker gets one that silently refuses nothing and finds out only from a badge later.
 *
 * Non-interactive by design: `supi` is used from scripts as much as a terminal, so the notice is a
 * printed warning rather than a confirmation prompt that would hang a script with no stdin.
 */
describe("supi link add --to-board", () => {
  it("prints the advisory notice BEFORE the request, for a cross-board target", async () => {
    const order: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      order.push(String(chunk));
      return true;
    });
    fetchMock.mockImplementation(async () => {
      order.push("FETCH");
      return new Response(JSON.stringify({ link: { enforced: false } }), { status: 201 });
    });

    await run(["link", "add", "brd_1", "card_a", "card_b", "--kind", "blocks", "--to-board", "brd_2"]);

    const noticeIndex = order.findIndex((line) => /advisory/i.test(line) && /not (be )?enforced/i.test(line));
    const fetchIndex = order.indexOf("FETCH");
    expect(noticeIndex, "the notice must be printed at all").toBeGreaterThanOrEqual(0);
    expect(fetchIndex, "the request must be sent").toBeGreaterThanOrEqual(0);
    expect(noticeIndex, "and the notice must come BEFORE the request, not after").toBeLessThan(fetchIndex);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/boards/brd_1/links");
    expect(JSON.parse(init?.body as string)).toEqual({
      fromCardId: "card_a",
      toCardId: "card_b",
      kind: "blocks",
      toBoardId: "brd_2",
    });
  });

  it("sends toBoardId without printing the advisory notice when it matches the path board", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ link: { enforced: true } }), { status: 201 }));

    await run(["link", "add", "brd_1", "card_a", "card_b", "--kind", "blocks", "--to-board", "brd_1"]);

    const printed = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(printed.some((line) => /advisory/i.test(line))).toBe(false);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      fromCardId: "card_a",
      toCardId: "card_b",
      kind: "blocks",
      toBoardId: "brd_1",
    });
  });

  it("omits toBoardId from the body, and prints no notice, when --to-board is not given", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ link: {} }), { status: 201 }));

    await run(["link", "add", "brd_1", "card_a", "card_b", "--kind", "blocks"]);

    const printed = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(printed.some((line) => /advisory/i.test(line))).toBe(false);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({ fromCardId: "card_a", toCardId: "card_b", kind: "blocks" });
  });
});

describe("supi link rm", () => {
  it("DELETEs fromCardId/toCardId/kind against the board's links route", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await run(["link", "rm", "brd_1", "card_a", "card_b", "--kind", "relates"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/boards/brd_1/links");
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(init?.body as string)).toEqual({ fromCardId: "card_a", toCardId: "card_b", kind: "relates" });
  });

  it("rejects an unknown --kind without sending a request", async () => {
    await expect(run(["link", "rm", "brd_1", "card_a", "card_b", "--kind", "nope"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("carries --to-board through to the DELETE body, for removing a cross-board edge", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await run(["link", "rm", "brd_1", "card_a", "card_b", "--kind", "blocks", "--to-board", "brd_2"]);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      fromCardId: "card_a",
      toCardId: "card_b",
      kind: "blocks",
      toBoardId: "brd_2",
    });
  });
});

describe("supi link list", () => {
  it("GETs the card's links route", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ links: [], externalLinks: [] }), { status: 200 }));

    await run(["link", "list", "brd_1", "card_a"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/boards/brd_1/cards/card_a/links");
    expect(init?.method ?? "GET").toBe("GET");
  });
});

describe("supi link (usage)", () => {
  it("fails with a usage message for an unrecognised sub-verb", async () => {
    await expect(run(["link", "frobnicate", "brd_1"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("supi archive", () => {
  it("PATCHes archivedAt with a real timestamp", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ card: {} }), { status: 200 }));

    await run(["archive", "brd_1", "card_a"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/boards/brd_1/cards/card_a");
    expect(init?.method).toBe("PATCH");
    const body = JSON.parse(init?.body as string) as { archivedAt: string };
    expect(Number.isNaN(Date.parse(body.archivedAt))).toBe(false);
  });

  it("fails with usage when boardId or cardId is missing", async () => {
    await expect(run(["archive", "brd_1"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
