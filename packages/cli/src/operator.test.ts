import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The operator verbs: `supi capability define`, `supi agent create` and `supi agent mint-token`.
 *
 * Modelled on `project.test.ts`: a person's token in the environment, a mocked `fetch`, and a
 * dynamic import of `./index` with `process.argv` stubbed — so this checks the REQUEST each verb
 * sends and what it PRINTS, not merely that the switch dispatches. Who may do these is the server's
 * decision (apps/api/test/operator-acts-plane-human.test.ts); what is here is that a minted secret
 * goes exactly where the person asked and nowhere else.
 */
const fetchMock = vi.fn<typeof fetch>();
const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ sub: "human", principalKind: "human", exp })).toString("base64url")}.sig`;
let token: string;
let stdout: string[];
let stderr: string[];

const SECRET = "spa_0123456789abcdef0123456789abcdef";

class ExitSignal extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  token = jwt(Math.floor(Date.now() / 1000) + 300);
  vi.stubEnv("SUPERPIPELINE_TOKEN", token);
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
});

async function run(argv: string[]): Promise<void> {
  vi.spyOn(process, "argv", "get").mockReturnValue(["bun", "supi", ...argv]);
  await import("./index");
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("supi capability define", () => {
  it("PATCHes the definition straight onto a capability named by its id", async () => {
    fetchMock.mockResolvedValue(json({ capability: { id: "cap_1", key: "code", description: "Writes code." } }));

    await run(["capability", "define", "cap_1", "--definition", "Writes code."]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/capabilities/cap_1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ description: "Writes code." });
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  });

  it("finds a capability named by its key — in the spelling a stage would carry — and PATCHes it by id", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ capabilities: [{ id: "cap_9", key: "code-review" }] }))
      .mockResolvedValueOnce(json({ capability: { id: "cap_9", key: "code-review" } }));

    await run(["capability", "define", "Code Review", "--definition", "Reads a diff and says what is wrong."]);

    expect(fetchMock.mock.calls[0]![0]).toBe("https://work.example/v1/capabilities");
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("https://work.example/v1/capabilities/cap_9");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ description: "Reads a diff and says what is wrong." });
  });

  it("declares a key the registry does not hold yet, with its definition", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ capabilities: [{ id: "cap_9", key: "code" }] }))
      .mockResolvedValueOnce(json({ capability: { id: "cap_2", key: "coordination" } }, 201));

    await run(["capability", "define", "coordination", "--definition", "Plans and queues work."]);

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("https://work.example/v1/capabilities");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ key: "coordination", description: "Plans and queues work." });
  });

  it("refuses to send anything without --definition", async () => {
    await expect(run(["capability", "define", "code"])).rejects.toBeInstanceOf(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("supi agent create", () => {
  it("POSTs the name, capabilities, principal and concurrency", async () => {
    fetchMock.mockResolvedValue(json({ agent: { id: "agt_1" } }, 201));

    await run([
      "agent", "create",
      "--name", "Coordinator",
      "--capability", "coordination",
      "--capability", "triage,planning",
      "--external-id", "prn_0123456789abcdef0123",
      "--concurrency", "3",
    ]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/agents");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      name: "Coordinator",
      capabilities: ["coordination", "triage", "planning"],
      externalId: "prn_0123456789abcdef0123",
      concurrency: 3,
    });
  });

  it("leaves concurrency to the server's default when it is not given", async () => {
    fetchMock.mockResolvedValue(json({ agent: { id: "agt_1" } }, 201));
    await run(["agent", "create", "--name", "A", "--capability", "code", "--external-id", "prn_0123456789abcdef0123"]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]?.body as string)).not.toHaveProperty("concurrency");
  });

  it.each([
    ["no --name", ["--capability", "code", "--external-id", "prn_0123456789abcdef0123"]],
    ["no --capability", ["--name", "A", "--external-id", "prn_0123456789abcdef0123"]],
    ["no --external-id", ["--name", "A", "--capability", "code"]],
    ["a malformed --external-id", ["--name", "A", "--capability", "code", "--external-id", "usr_1"]],
    ["--concurrency 0", ["--name", "A", "--capability", "code", "--external-id", "prn_0123456789abcdef0123", "--concurrency", "0"]],
  ])("refuses %s before anything is sent", async (_, args) => {
    await expect(run(["agent", "create", ...args])).rejects.toBeInstanceOf(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("supi agent mint-token", () => {
  it.each([
    ["claim-run", ["claim", "run"]],
    ["run-only", ["run"]],
  ])("--kind %s asks for exactly those scopes", async (kind, scopes) => {
    fetchMock.mockResolvedValue(json({ token: SECRET, tokenId: "tok_1", scopes }, 201));

    await run(["agent", "mint-token", "agt_1", "--kind", kind]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://work.example/v1/agents/agt_1/tokens");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ scopes });
  });

  it("prints the secret once, on stdout, and never on stderr", async () => {
    fetchMock.mockResolvedValue(json({ token: SECRET, tokenId: "tok_1", scopes: ["claim", "run"] }, 201));

    await run(["agent", "mint-token", "agt_1", "--kind", "claim-run"]);

    expect(occurrences(stdout.join(""), SECRET)).toBe(1);
    expect(stderr.join("")).not.toContain(SECRET);
    // The rest — which token, what it may do, that it will not be shown again — goes to stderr, so
    // `supi agent mint-token … > file` captures the secret and nothing else.
    expect(stdout.join("").trim()).toBe(SECRET);
    expect(stderr.join("")).toContain("tok_1");
  });

  it("--json carries the secret in its one field, once", async () => {
    fetchMock.mockResolvedValue(json({ token: SECRET, tokenId: "tok_1", scopes: ["run"] }, 201));

    await run(["agent", "mint-token", "agt_1", "--kind", "run-only", "--json"]);

    const printed = stdout.join("");
    expect(occurrences(printed, SECRET)).toBe(1);
    expect(JSON.parse(printed)).toEqual({ agentId: "agt_1", kind: "run-only", tokenId: "tok_1", scopes: ["run"], token: SECRET });
    expect(stderr.join("")).not.toContain(SECRET);
  });

  it("--out writes the secret to a 0600 file and prints it nowhere", async () => {
    fetchMock.mockResolvedValue(json({ token: SECRET, tokenId: "tok_1", scopes: ["run"] }, 201));
    const dir = mkdtempSync(join(tmpdir(), "supi-mint-"));
    const out = join(dir, "run-only.token");

    await run(["agent", "mint-token", "agt_1", "--kind", "run-only", "--out", out, "--json"]);

    expect(readFileSync(out, "utf8").trim()).toBe(SECRET);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(stdout.join("")).not.toContain(SECRET);
    expect(stderr.join("")).not.toContain(SECRET);
    expect(JSON.parse(stdout.join(""))).toEqual({ agentId: "agt_1", kind: "run-only", tokenId: "tok_1", scopes: ["run"], out });
  });

  it("--out tightens a file that already exists to 0600 rather than inheriting its mode", async () => {
    fetchMock.mockResolvedValue(json({ token: SECRET, tokenId: "tok_1", scopes: ["run"] }, 201));
    const dir = mkdtempSync(join(tmpdir(), "supi-mint-"));
    const out = join(dir, "existing.token");
    writeFileSync(out, "old", { mode: 0o644 });

    await run(["agent", "mint-token", "agt_1", "--kind", "run-only", "--out", out]);

    expect(readFileSync(out, "utf8").trim()).toBe(SECRET);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["no --kind", ["agt_1"]],
    ["an unknown --kind", ["agt_1", "--kind", "admin"]],
    ["no agent", ["--kind", "run-only"]],
  ])("refuses %s before anything is sent", async (_, args) => {
    await expect(run(["agent", "mint-token", ...args])).rejects.toBeInstanceOf(ExitSignal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a refusal from the server mints nothing and prints no secret", async () => {
    fetchMock.mockResolvedValue(json({ error: "this is not something an agent may do in this workspace" }, 403));
    await expect(run(["agent", "mint-token", "agt_1", "--kind", "claim-run"])).rejects.toBeInstanceOf(ExitSignal);
    expect(stdout.join("")).not.toContain("spa_");
    expect(stderr.join("")).toContain("not something an agent may do");
  });
});
