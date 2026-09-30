import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `supi schedule list|add|rm|pause|resume` — the client for Task 10's
 * `GET|POST /v1/boards/:id/schedules` and `PATCH|DELETE /v1/boards/:id/schedules/:scheduleId`.
 *
 * Modelled on `renewal.test.ts`'s "wires renewal into the real %s command" case: a real token in
 * the environment, a mocked `fetch`, and a dynamic import of `./index` with `process.argv`
 * stubbed — the only way to drive `main()` as a person actually would, rather than asserting the
 * switch merely dispatches (Phase 1's `/v1/labels` 401'd for every hub-token caller despite a
 * "dispatches" test passing; this checks the REQUEST each verb sends, not just that one fires).
 */
const fetchMock = vi.fn<typeof fetch>();
const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ sub: "human", principalKind: "human", exp })).toString("base64url")}.sig`;
const fresh = () => jwt(Math.floor(Date.now() / 1000) + 300);
// Captured once per test, not recomputed at assertion time — `fresh()` embeds the current second,
// and calling it twice can straddle a second boundary and mint two different tokens.
let token: string;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  token = fresh();
  vi.stubEnv("SUPERPIPELINE_TOKEN", token);
  vi.stubEnv("AGENTPOD_TOKEN", "");
  vi.stubEnv("SUPERPIPELINE_URL", "https://work.example");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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

describe("supi schedule", () => {
  it("list GETs the board's schedules route", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ schedules: [] }), { status: 200 }));

    await run(["schedule", "list", "brd_1"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/boards/brd_1/schedules");
    expect(init?.method ?? "GET").toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  });

  it("add POSTs the required fields, with overlap defaulted to 'skip' as a shape the server understands", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ schedule: { id: "sch_1" } }), { status: 201 }));

    await run(["schedule", "add", "brd_1", "--title", "Sweep", "--rule", "daily at 09:00", "--tz", "UTC"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/boards/brd_1/schedules");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ title: "Sweep", rule: "daily at 09:00", timezone: "UTC" });
  });

  it("add carries --stage, --priority and --overlap when given", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ schedule: { id: "sch_1" } }), { status: 201 }));

    await run([
      "schedule", "add", "brd_1",
      "--title", "Sweep",
      "--rule", "daily at 09:00",
      "--tz", "Asia/Kolkata",
      "--stage", "review",
      "--priority", "5",
      "--overlap", "allow",
    ]);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      title: "Sweep",
      rule: "daily at 09:00",
      timezone: "Asia/Kolkata",
      stageKey: "review",
      priority: 5,
      overlap: "allow",
    });
  });

  it("rm DELETEs the schedule", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await run(["schedule", "rm", "brd_1", "sch_1"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/boards/brd_1/schedules/sch_1");
    expect(init?.method).toBe("DELETE");
  });

  it("pause PATCHes enabled:false", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ schedule: { id: "sch_1", enabled: false } }), { status: 200 }));

    await run(["schedule", "pause", "brd_1", "sch_1"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/boards/brd_1/schedules/sch_1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ enabled: false });
  });

  it("resume PATCHes enabled:true", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ schedule: { id: "sch_1", enabled: true } }), { status: 200 }));

    await run(["schedule", "resume", "brd_1", "sch_1"]);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ enabled: true });
  });
});
