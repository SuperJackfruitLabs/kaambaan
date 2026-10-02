/**
 * What `supi` will and will not authenticate with.
 *
 * This used to test an absence: `supi` never read a `spa_` AGENT token at all, because "an agent is
 * not a person operating a board". That stopped being the operating model on 2026-10-02 — the
 * operator does not drive this CLI routinely, agents do, and a coordinator that cannot use it is a
 * commentator.
 *
 * What Decision 2 actually protects is unchanged and is what these tests now pin: a human's
 * decisions must never be attributed to an agent, or an agent's to a human. So an agent token is
 * read only from a variable that NAMES it, every credential says which kind it is, and the two are
 * never silently interchangeable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BASE,
  ENV_BASE,
  ENV_AGENT_TOKEN,
  ENV_HUB_TOKEN,
  ENV_TOKEN,
  baseUrl,
  describeCredential,
  expired,
  inspect,
  loadCredential,
  refusalHint,
  fleetConfigDir,
} from "./credential";

let home: string;
beforeEach(() => {
  for (const k of [ENV_TOKEN, ENV_HUB_TOKEN, ENV_AGENT_TOKEN, ENV_BASE]) vi.stubEnv(k, "");
  // Redirect every platform's config directory, never the developer's real credentials.
  home = mkdtempSync(join(tmpdir(), "supi-"));
  for (const k of ["HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME"]) vi.stubEnv(k, home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function writeApnToken(token: string): void {
  const dir = fleetConfigDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "token.json"), JSON.stringify({ token }));
}

describe("loadCredential", () => {
  it("prefers its own variable", () => {
    vi.stubEnv(ENV_TOKEN, "  own-token  ");
    vi.stubEnv(ENV_HUB_TOKEN, "hub-token");
    const c = loadCredential();
    expect(c?.token).toBe("own-token");
    expect(c?.source).toBe(`env:${ENV_TOKEN}`);
  });

  it("falls back to the hub token, because that IS what superpipeline accepts", () => {
    vi.stubEnv(ENV_HUB_TOKEN, "hub-token");
    expect(loadCredential()?.token).toBe("hub-token");
  });

  it("then the file `fleet login` writes — one sign-in, both planes", () => {
    writeApnToken("from-file");
    const c = loadCredential();
    expect(c?.token).toBe("from-file");
    expect(c?.source).toContain("agentpod");
  });

  it("returns null when there is nothing, rather than inventing something", () => {
    expect(loadCredential()).toBeNull();
  });

  it("ignores an empty or whitespace-only variable", () => {
    vi.stubEnv(ENV_TOKEN, "   ");
    expect(loadCredential()).toBeNull();
  });

  it("ignores an agent token sitting in a variable this CLI does not read", () => {
    vi.stubEnv("KBN_TOKEN", "spa_deadbeef");
    expect(loadCredential()).toBeNull();
  });

  it("labels a human credential as one", () => {
    vi.stubEnv(ENV_TOKEN, "eyJhbGciOi.payload.sig");
    expect(loadCredential()).toMatchObject({ kind: "human" });
  });
});

describe("an agent credential", () => {
  it("is read from the variable that names it, and labelled an agent's", () => {
    // The operator does not drive this CLI; their coordinator agent does. One that can read ten
    // boards and put a shaped card on one is the whole point of the change this supports.
    vi.stubEnv(ENV_AGENT_TOKEN, "spa_coord0000");
    expect(loadCredential()).toMatchObject({
      token: "spa_coord0000",
      kind: "agent",
      source: `env:${ENV_AGENT_TOKEN}`,
    });
  });

  it("OUTRANKS a human token, because an agent's shell may carry both", () => {
    // A station's environment can easily hold a leftover hub token from `fleet login`. If that won,
    // the agent would act as the operator — indistinguishably, which is the exact failure the
    // control pair and `queued_by_agent_id` exist to make impossible.
    vi.stubEnv(ENV_TOKEN, "eyJhbGciOi.payload.sig");
    vi.stubEnv(ENV_AGENT_TOKEN, "spa_coord0000");
    expect(loadCredential()).toMatchObject({ kind: "agent" });
  });

  it("REFUSES a non-spa_ value in the agent slot rather than acting as a person", () => {
    // A hub token here would authenticate fine and act as whoever it names — a human — while the
    // caller believed it was acting as an agent. Silently honouring it is how provenance becomes a
    // lie; refusing names the mistake.
    vi.stubEnv(ENV_AGENT_TOKEN, "eyJhbGciOi.payload.sig");
    expect(() => loadCredential()).toThrow(/spa_/);
  });

  it("REFUSES a spa_ token in the human slot, for the same reason in reverse", () => {
    vi.stubEnv(ENV_TOKEN, "spa_coord0000");
    expect(() => loadCredential()).toThrow(new RegExp(ENV_AGENT_TOKEN));
  });

  it("ignores whitespace, so an unset variable is unset", () => {
    vi.stubEnv(ENV_AGENT_TOKEN, "   ");
    expect(loadCredential()).toBeNull();
  });
});

describe("baseUrl", () => {
  it("defaults to production", () => {
    expect(baseUrl()).toBe(DEFAULT_BASE);
  });
  it("honours an override and strips trailing slashes", () => {
    vi.stubEnv(ENV_BASE, "http://localhost:8787///");
    expect(baseUrl()).toBe("http://localhost:8787");
  });
});

function jwt(payload: Record<string, unknown>): string {
  return `aGRy.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;
}

describe("inspect", () => {
  it("reads claims without verifying the signature", () => {
    // Deliberate: this is `whoami`, not an authorization decision. superpipeline verifies.
    const c = inspect(jwt({ sub: "prn_x", principalKind: "human", exp: 2000000000 }));
    expect(c?.subject).toBe("prn_x");
    expect(c?.principalKind).toBe("human");
    expect(expired(c!)).toBe(false);
  });

  it("detects an expired token", () => {
    expect(expired(inspect(jwt({ sub: "x", exp: 1 }))!)).toBe(true);
  });

  it("treats a missing exp as not expired — absence is not evidence of staleness", () => {
    expect(expired(inspect(jwt({ sub: "x" }))!)).toBe(false);
  });

  it("returns null for anything that is not a JWT", () => {
    for (const bad of ["", "nope", "only.two"]) expect(inspect(bad)).toBeNull();
  });
});

/**
 * Where the token lives is a PLATFORM rule, and it must stay the rule Go's `os.UserConfigDir()`
 * applies — `agentpod/apps/node-agent/internal/fleetcred/fleetcred.go` locates the same file that
 * way. An earlier version of this CLI implemented only the Linux branch, so on macOS it read
 * `~/.config` while `fleet login` wrote `~/Library/Application Support`: same filename, different
 * directory, never a hit. The tests above all stub every platform's variable to one directory, so
 * they pass whichever branch runs and cannot catch that. These pin each branch by itself.
 */
describe("fleetConfigDir pins Go's os.UserConfigDir() per platform", () => {
  it("macOS: ~/Library/Application Support, ignoring XDG_CONFIG_HOME", () => {
    vi.stubEnv("HOME", "/Users/someone");
    vi.stubEnv("XDG_CONFIG_HOME", "/xdg/must/be/ignored");
    expect(fleetConfigDir("darwin")).toBe("/Users/someone/Library/Application Support/agentpod");
  });

  it("Linux: XDG_CONFIG_HOME when set", () => {
    vi.stubEnv("HOME", "/home/someone");
    vi.stubEnv("XDG_CONFIG_HOME", "/xdg");
    expect(fleetConfigDir("linux")).toBe("/xdg/agentpod");
  });

  it("Linux: ~/.config when XDG_CONFIG_HOME is unset", () => {
    vi.stubEnv("HOME", "/home/someone");
    vi.stubEnv("XDG_CONFIG_HOME", "");
    expect(fleetConfigDir("linux")).toBe("/home/someone/.config/agentpod");
  });
});

describe("describeCredential", () => {
  // `whoami` is the first thing a caller runs to check what it is acting as, and for an agent it
  // used to fail outright: a `spa_` token is opaque, `inspect` returns null, and the CLI answered
  // "The stored credential is not a token this can read." — which reads like a broken credential
  // and describes a working one.
  it("reports an agent honestly, including what it cannot know", () => {
    expect(describeCredential({ token: "spa_x", source: "env:X", kind: "agent" })).toEqual({
      principal: null,
      kind: "agent",
      source: "env:X",
      expires: null,
    });
  });

  it("reads a human's claims as before", () => {
    const token = jwt({ sub: "usr_1", principalKind: "human", exp: 2_000_000_000 });
    expect(describeCredential({ token, source: "env:Y", kind: "human" })).toMatchObject({
      principal: "usr_1",
      kind: "human",
    });
  });

  it("returns null for a human credential it cannot parse, so the caller can still refuse", () => {
    expect(describeCredential({ token: "not-a-jwt", source: "env:Y", kind: "human" })).toBeNull();
  });
});

describe("refusalHint", () => {
  /**
   * A 403 sends the reader somewhere. Which somewhere depends on what is holding the credential.
   *
   * Observed live: a coordinator agent, holding a `read`-scoped token, was refused card creation with
   * `this token is not permitted to queue` — correctly — and then told "Your seat in this workspace
   * does not permit that. An AgentPod identity reads as `member` until it is linked to a
   * superpipeline account — sign in once at the web app." Every word of that is about a HUMAN's
   * role, and none of it is actionable by an agent whose scopes are the actual answer. An error that
   * sends somebody looking in the wrong place costs more than no error.
   */
  it("points an AGENT at its scopes and its grant, not at account linking", () => {
    const hint = refusalHint("agent");
    expect(hint).toMatch(/scope/i);
    expect(hint).not.toMatch(/sign in/i);
    expect(hint).not.toMatch(/seat/i);
  });

  it("still points a PERSON at the seat and the account link", () => {
    const hint = refusalHint("human");
    expect(hint).toMatch(/seat/i);
    expect(hint).toMatch(/link/i);
  });
});
