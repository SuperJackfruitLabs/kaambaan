import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetConfigDir, resolveCredential } from "./credential";

let home: string;
const hub = "https://issuer.example";
const jwt = (exp: number) => `e30.${Buffer.from(JSON.stringify({ sub: "human", principalKind: "human", exp })).toString("base64url")}.sig`;
const fresh = () => jwt(Math.floor(Date.now() / 1000) + 300);
const stale = () => jwt(1);
const fetchMock = vi.fn<typeof fetch>();
function file(name: string, value: unknown) {
  mkdirSync(fleetConfigDir(), { recursive: true });
  writeFileSync(join(fleetConfigDir(), name), JSON.stringify(value));
}
function device(extra = {}) {
  file("device.json", { id: "dev_fixture", secret: "fixture-secret", hub, ...extra });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "supi-renewal-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, "xdg"));
  vi.stubEnv("APPDATA", join(home, "AppData"));
  vi.stubEnv("SUPERPIPELINE_TOKEN", "");
  vi.stubEnv("AGENTPOD_TOKEN", "");
  vi.stubEnv("SUPERPIPELINE_URL", "https://work.example");
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("fleet credential compatibility", () => {
  it("uses Go's per-platform config locations, including macOS instead of XDG", () => {
    expect(fleetConfigDir("darwin")).toBe(join(home, "Library", "Application Support", "agentpod"));
    expect(fleetConfigDir("win32")).toBe(join(home, "AppData", "agentpod"));
    expect(fleetConfigDir("linux")).toBe(join(home, "xdg", "agentpod"));
    vi.stubEnv("XDG_CONFIG_HOME", "");
    expect(fleetConfigDir("linux")).toBe(join(home, ".config", "agentpod"));
  });

  it("never replaces an explicit expired environment token with a disk identity", async () => {
    const token = stale();
    vi.stubEnv("SUPERPIPELINE_TOKEN", token);
    vi.stubEnv("AGENTPOD_TOKEN", fresh());
    device();
    expect(await resolveCredential()).toEqual({ token, source: "env:SUPERPIPELINE_TOKEN", kind: "human" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a fresh cached token without network traffic", async () => {
    const token = fresh();
    file("token.json", { token, hub });
    device();
    expect((await resolveCredential())?.token).toBe(token);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["expired", "absent", "corrupt"])("exchanges a device when the cache is %s and reuses the result", async (state) => {
    if (state === "expired") file("token.json", { token: stale(), hub });
    if (state === "corrupt") file("token.json", null);
    device();
    const token = fresh();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token, expiresIn: 300 })));
    const result = await resolveCredential();
    expect(result?.token).toBe(token);
    expect(fetchMock).toHaveBeenCalledWith(`${hub}/api/auth/devices/token?client=apn`, expect.objectContaining({
      method: "POST", redirect: "error", signal: expect.any(AbortSignal),
      headers: { Authorization: "Bearer dev_fixture:fixture-secret" },
    }));
    expect(JSON.parse(readFileSync(join(fleetConfigDir(), "token.json"), "utf8"))).toEqual({ token, hub });
    if (process.platform !== "win32") expect(statSync(join(fleetConfigDir(), "token.json")).mode & 0o777).toBe(0o600);
    expect((await resolveCredential())?.token).toBe(token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the credential's issuer, never the work API override", async () => {
    vi.stubEnv("SUPERPIPELINE_URL", "https://work.example");
    device();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: fresh() })));
    await resolveCredential();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${hub}/api/auth/devices/token?client=apn`);
  });

  it.each(["", "http://issuer.example", "https://user:pass@issuer.example", "https://issuer.example/?token=secret"])("does not send a device to an unsafe/missing issuer %s", async (hub) => {
    device({ hub });
    await expect(resolveCredential()).rejects.toThrow(/fleet login/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a loopback HTTP issuer for local development", async () => {
    device({ hub: "http://127.0.0.1:8080" });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: fresh() })));
    await resolveCredential();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8080/api/auth/devices/token?client=apn");
  });

  it.each([401, 403, 500])("fails without leaking response bodies or modifying credentials on HTTP %s", async (status) => {
    device();
    file("token.json", { token: stale(), hub });
    const before = readFileSync(join(fleetConfigDir(), "token.json"), "utf8");
    fetchMock.mockResolvedValue(new Response("fixture-secret", { status }));
    await expect(resolveCredential()).rejects.toThrow(/renew/);
    expect(readFileSync(join(fleetConfigDir(), "token.json"), "utf8")).toBe(before);
    expect(readFileSync(join(fleetConfigDir(), "device.json"), "utf8")).toContain("fixture-secret");
  });

  it.each([null, { token: "" }, { token: 42 }, { token: jwt(0) }, { token: "not-a-token" }])("rejects an unusable exchange response %j", async (body) => {
    device();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(resolveCredential()).rejects.toThrow(/renew/);
  });

  it("does not expose network error details", async () => {
    device();
    fetchMock.mockRejectedValue(new Error("fixture-secret"));
    await expect(resolveCredential()).rejects.toThrow("Could not renew the fleet token. Check the hub connection and try again.");
  });

  it("keeps a fresh token usable if its cache cannot be written", async () => {
    device();
    mkdirSync(join(fleetConfigDir(), "token.json"));
    const token = fresh();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token })));
    expect((await resolveCredential())?.token).toBe(token);
  });

  it("leaves a legacy expired cache available for the CLI's expiry guidance when there is no device", async () => {
    file("token.json", { token: stale() });
    expect((await resolveCredential())?.token).toBe(stale());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["boards", "whoami"])("wires renewal into the real %s command without leaking the device secret", async (command) => {
    device();
    file("token.json", { token: stale(), hub });
    const token = fresh();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ token })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ boards: [] })));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process, "argv", "get").mockReturnValue(["bun", "supi", command]);
    await import("./index");
    expect(fetchMock).toHaveBeenCalledTimes(command === "boards" ? 2 : 1);
    if (command === "whoami") return;
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${token}` }));
    expect(JSON.stringify(fetchMock.mock.calls[1])).not.toContain("fixture-secret");
  });
});

/**
 * A renewal has to ask for the same planes the sign-in reached.
 *
 * The hub's device exchange mints for the hub ALONE unless the request names a registered client
 * (`routes/devices.ts`; the audiences live on `OAuthClient.audiences`). So `fleet login` produced
 * a token this API accepts, and the first silent renewal five minutes later produced one it does
 * not: `supi boards` answered 401 while `supi whoami` looked perfect, because whoami never leaves
 * the machine.
 *
 * `apn` is the same registry entry `fleet login` authorizes as, and the same one
 * `fleetcred.ExchangeDevice` sends. Three places must agree on it; a renewal naming a different
 * client would be this same bug wearing a different hat.
 */
describe("the renewal names its client", () => {
  it("asks for the apn client, so the token it caches reaches this API and not only the hub", async () => {
    device();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: fresh() })));
    await resolveCredential();
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("client")).toBe("apn");
    // The issuer is still the credential's own, never SUPERPIPELINE_URL: naming a client widens
    // where the token may be SPENT and must not change who is asked to mint it.
    expect(url.origin).toBe(new URL(hub).origin);
    expect(url.pathname).toBe("/api/auth/devices/token");
  });
});
