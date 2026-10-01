import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `supi project list|add|show|rm` and `supi milestone add|rm` — the CLI's client for Task 18's
 * project/milestone routes (`/v1/projects[/:id[/milestones]]`, `/v1/milestones/:id`) and Task 19's
 * rollup is NOT reached from here — no CLI verb reads it in this task.
 *
 * Modelled on `link.test.ts`: a real token in the environment, a mocked `fetch`, and a dynamic
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

describe("supi project list", () => {
  it("GETs /v1/projects", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ projects: [] }), { status: 200 }));

    await run(["project", "list"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/projects");
    expect(init?.method ?? "GET").toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  });
});

describe("supi project add", () => {
  it("POSTs the name to /v1/projects", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ project: {} }), { status: 201 }));

    await run(["project", "add", "Launch"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/projects");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ name: "Launch" });
  });

  it("carries --description, --target and --lead when given", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ project: {} }), { status: 201 }));

    await run([
      "project",
      "add",
      "Launch",
      "--description",
      "Q4 push",
      "--target",
      "2026-12-01",
      "--lead",
      "usr_1",
    ]);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      name: "Launch",
      description: "Q4 push",
      targetDate: "2026-12-01",
      leadUserId: "usr_1",
    });
  });

  it("rejects a malformed --target without sending a request", async () => {
    await expect(run(["project", "add", "Launch", "--target", "not-a-date"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails with usage when the name is missing", async () => {
    await expect(run(["project", "add"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("supi project show", () => {
  it("GETs /v1/projects/:id", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ project: { id: "prj_1" }, milestones: [] }), { status: 200 }),
    );

    await run(["project", "show", "prj_1"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/projects/prj_1");
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("fails with usage when the project id is missing", async () => {
    await expect(run(["project", "show"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("supi project rm", () => {
  it("DELETEs /v1/projects/:id", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await run(["project", "rm", "prj_1"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/projects/prj_1");
    expect(init?.method).toBe("DELETE");
  });

  it("fails with usage when the project id is missing", async () => {
    await expect(run(["project", "rm"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("supi project (usage)", () => {
  it("fails with a usage message for an unrecognised sub-verb", async () => {
    await expect(run(["project", "frobnicate"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("supi milestone add", () => {
  it("POSTs the name to the project's milestones route", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ milestone: {} }), { status: 201 }));

    await run(["milestone", "add", "prj_1", "Beta"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/projects/prj_1/milestones");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ name: "Beta" });
  });

  it("carries --target and --sort when given", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ milestone: {} }), { status: 201 }));

    await run(["milestone", "add", "prj_1", "Beta", "--target", "2026-11-01", "--sort", "2"]);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({ name: "Beta", targetDate: "2026-11-01", sortOrder: 2 });
  });

  it("rejects a non-numeric --sort without sending a request", async () => {
    await expect(run(["milestone", "add", "prj_1", "Beta", "--sort", "soon"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed --target without sending a request", async () => {
    await expect(run(["milestone", "add", "prj_1", "Beta", "--target", "11/01/2026"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails with usage when projectId or name is missing", async () => {
    await expect(run(["milestone", "add", "prj_1"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("supi milestone rm", () => {
  it("DELETEs against /v1/milestones/:id, not the project route", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await run(["milestone", "rm", "mil_1"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/milestones/mil_1");
    expect(init?.method).toBe("DELETE");
  });

  it("fails with usage when the milestone id is missing", async () => {
    await expect(run(["milestone", "rm"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("supi milestone (usage)", () => {
  it("fails with a usage message for an unrecognised sub-verb", async () => {
    await expect(run(["milestone", "frobnicate", "prj_1"])).rejects.toThrow(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
