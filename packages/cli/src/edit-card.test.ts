import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `supi edit-card`: the CLI's verb for the PATCH the web drawer already sends.
 *
 * Modelled on `operator.test.ts` — a mocked `fetch` and `process.argv`, so this checks the REQUESTS
 * the verb sends and what it prints. Who may edit is the server's decision; what is held here is
 * `--merge-spec`'s read-modify-write: it reads the card, merges one level deep, and writes back
 * ONLY IF the card is unchanged since the read.
 */
const fetchMock = vi.fn<typeof fetch>();
const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ sub: "human", principalKind: "human", exp })).toString("base64url")}.sig`;
let stdout: string[];
let stderr: string[];
let dir: string;

class ExitSignal extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.stubEnv("SUPERPIPELINE_TOKEN", jwt(Math.floor(Date.now() / 1000) + 300));
  vi.stubEnv("AGENTPOD_TOKEN", "");
  vi.stubEnv("SUPERPIPELINE_URL", "https://work.example");
  stdout = [];
  stderr = [];
  dir = mkdtempSync(join(tmpdir(), "supi-edit-"));
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

async function run(argv: string[]): Promise<number | undefined> {
  // Fresh each time: a second `import` of a cached module would not run the CLI again, and a test
  // with several runs would pass on the first one alone.
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
const file = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const sent = (i: number) => {
  const [url, init] = fetchMock.mock.calls[i]!;
  return { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined };
};

const URL_ = "https://work.example/v1/boards/brd_1/cards/crd_1";
const CARD = { id: "crd_1", title: "T", spec: { goal: "ship", notes: "old", keep: [1, 2] }, updatedAt: "2026-10-08T10:00:00.000Z" };

describe("supi edit-card — plain fields", () => {
  it("PATCHes only the fields named, and prints the updated card", async () => {
    fetchMock.mockResolvedValueOnce(json({ card: { ...CARD, title: "New title", priority: 3 } }));

    expect(await run(["edit-card", "brd_1", "crd_1", "--title", "New title", "--priority", "3", "--due", "2026-11-01"])).toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(0)).toEqual({ url: URL_, method: "PATCH", body: { title: "New title", priority: 3, dueAt: "2026-11-01" } });
    expect(JSON.parse(stdout.join(""))).toMatchObject({ card: { title: "New title" } });
  });

  it("clears the due date with --due none", async () => {
    fetchMock.mockResolvedValueOnce(json({ card: CARD }));
    await run(["edit-card", "brd_1", "crd_1", "--due", "none"]);
    expect(sent(0).body).toEqual({ dueAt: null });
  });

  it("replaces the whole spec with --spec, without reading the card first", async () => {
    fetchMock.mockResolvedValueOnce(json({ card: CARD }));
    await run(["edit-card", "brd_1", "crd_1", "--spec", file("s.json", '{"goal":"only this"}')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(0).body).toEqual({ spec: { goal: "only this" } });
  });

  it("refuses before sending anything: no field, a bad date, a bad priority, both spec flags", async () => {
    expect(await run(["edit-card", "brd_1", "crd_1"])).toBe(1);
    expect(await run(["edit-card", "brd_1", "crd_1", "--due", "tuesday"])).toBe(1);
    expect(await run(["edit-card", "brd_1", "crd_1", "--priority", "high"])).toBe(1);
    const s = file("s.json", "{}");
    expect(await run(["edit-card", "brd_1", "crd_1", "--spec", s, "--merge-spec", s])).toBe(1);
    expect(await run(["edit-card", "brd_1"])).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("supi edit-card --merge-spec", () => {
  it("reads the card, merges top-level keys, and writes back with the updatedAt it read", async () => {
    fetchMock.mockResolvedValueOnce(json({ card: CARD })).mockResolvedValueOnce(json({ card: CARD }));

    await run(["edit-card", "brd_1", "crd_1", "--merge-spec", file("m.json", '{"notes":"new","extra":{"a":1}}')]);

    expect(sent(0)).toMatchObject({ url: URL_, method: "GET" });
    expect(sent(1)).toEqual({
      url: URL_,
      method: "PATCH",
      body: {
        // Shallow: `keep` untouched, `notes` replaced, `extra` added as given.
        spec: { goal: "ship", notes: "new", keep: [1, 2], extra: { a: 1 } },
        expectedUpdatedAt: "2026-10-08T10:00:00.000Z",
      },
    });
  });

  it("replaces a nested object whole rather than merging into it, and removes a key set to null", async () => {
    const card = { ...CARD, spec: { goal: "ship", acceptance: { a: 1, b: 2 } } };
    fetchMock.mockResolvedValueOnce(json({ card })).mockResolvedValueOnce(json({ card }));

    await run(["edit-card", "brd_1", "crd_1", "--merge-spec", file("m.json", '{"acceptance":{"c":3},"goal":null}')]);

    expect(sent(1).body.spec).toEqual({ acceptance: { c: 3 } });
  });

  it("reads the merge from stdin with -", async () => {
    fetchMock.mockResolvedValueOnce(json({ card: CARD })).mockResolvedValueOnce(json({ card: CARD }));
    vi.doMock("node:fs", async (original) => {
      const real = await original<typeof import("node:fs")>();
      return { ...real, readFileSync: ((p: unknown, ...r: unknown[]) => (p === 0 ? '{"notes":"piped"}' : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...r))) as typeof real.readFileSync };
    });

    try {
      await run(["edit-card", "brd_1", "crd_1", "--merge-spec", "-"]);
    } finally {
      vi.doUnmock("node:fs");
    }

    expect(sent(1).body.spec).toMatchObject({ notes: "piped", goal: "ship" });
  });

  it("sends title and priority in the same write as the merged spec", async () => {
    fetchMock.mockResolvedValueOnce(json({ card: CARD })).mockResolvedValueOnce(json({ card: CARD }));
    await run(["edit-card", "brd_1", "crd_1", "--title", "T2", "--merge-spec", file("m.json", '{"notes":"n"}')]);
    expect(sent(1).body).toMatchObject({ title: "T2", expectedUpdatedAt: CARD.updatedAt });
  });

  it("says the card changed and that nothing was written, when the server answers 409", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ card: CARD }))
      .mockResolvedValueOnce(json({ error: { code: "CARD_CHANGED", message: "changed" } }, 409));

    expect(await run(["edit-card", "brd_1", "crd_1", "--merge-spec", file("m.json", '{"notes":"n"}')])).toBe(1);

    const err = stderr.join("");
    expect(err).toContain("changed since");
    expect(err).toContain("Nothing was written");
  });

  it("refuses a merge that is not a JSON object, and a card whose spec is not one", async () => {
    expect(await run(["edit-card", "brd_1", "crd_1", "--merge-spec", file("a.json", "[1,2]")])).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(json({ card: { ...CARD, spec: "prose" } }));
    expect(await run(["edit-card", "brd_1", "crd_1", "--merge-spec", file("m.json", '{"a":1}')])).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // read, never written
  });
});
