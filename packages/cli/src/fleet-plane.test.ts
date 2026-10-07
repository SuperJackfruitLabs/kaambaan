/**
 * `fleet login`'s credential after the Organization-plane cutover.
 *
 * Under the plane, `fleet login` stores a token minted for the HUB (`aud` = the hub) and a device
 * credential (`dev_…` + secret) good at the plane. supi used to send that hub token to
 * superpipeline, which refuses it 401 — so until a person ran `supi login`, every command failed
 * with a credential that looked perfectly healthy in `supi whoami`.
 *
 * Now: a stored token whose `aud` does not name this API is passed over, and fleet's device
 * credential is exchanged at its recorded plane for this API's audience (issuer contract §3.2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetConfigDir, resolveCredential } from "./credential";

let home: string;
const HUB = "https://hub.example";
const PLANE = "https://plane.example";
const WORK = "https://work.example";
const ID = `dev_${"a".repeat(20)}`;
const SECRET = "B".repeat(43);
const fetchMock = vi.fn<typeof fetch>();

const jwt = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify({ sub: "prn_h", principalKind: "human", exp: Math.floor(Date.now() / 1000) + 300, ...claims })).toString("base64url")}.sig`;

function file(name: string, value: unknown) {
  mkdirSync(fleetConfigDir(), { recursive: true });
  writeFileSync(join(fleetConfigDir(), name), JSON.stringify(value));
}
/** What `fleet login` writes under the plane. */
function planeDevice(extra = {}) {
  file("device.json", { id: ID, secret: SECRET, hub: HUB, plane_url: PLANE, issuer: PLANE, audience: HUB, ...extra });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "supi-fleet-plane-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, "xdg"));
  vi.stubEnv("APPDATA", join(home, "AppData"));
  vi.stubEnv("SUPERPIPELINE_TOKEN", "");
  vi.stubEnv("AGENTPOD_TOKEN", "");
  vi.stubEnv("SUPERPIPELINE_AGENT_TOKEN", "");
  vi.stubEnv("SUPERPIPELINE_AGENT_TOKEN_FILE", "");
  vi.stubEnv("SUPERPIPELINE_URL", WORK);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("fleet login's credential under the Organization plane", () => {
  it("passes over a stored token minted for the hub and exchanges the device at the plane for this API", async () => {
    file("token.json", { token: jwt({ aud: HUB }), hub: HUB });
    planeDevice();
    const minted = jwt({ aud: WORK });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: minted, token_type: "Bearer", expires_in: 300 })));

    const cred = await resolveCredential();

    expect(cred?.token).toBe(minted);
    expect(cred?.kind).toBe("human");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${PLANE}/api/token/device`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${ID}:${SECRET}`);
    expect(JSON.parse(String(init?.body))).toEqual({ audience: WORK });
  });

  it("reuses the exchanged token rather than exchanging on every command", async () => {
    file("token.json", { token: jwt({ aud: HUB }), hub: HUB });
    planeDevice();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: jwt({ aud: WORK }), expires_in: 300 })));

    await resolveCredential();
    await resolveCredential();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite fleet's own hub token, which fleet still needs", async () => {
    const hubToken = jwt({ aud: HUB });
    file("token.json", { token: hubToken, hub: HUB });
    planeDevice();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: jwt({ aud: WORK }), expires_in: 300 })));

    await resolveCredential();

    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(join(fleetConfigDir(), "token.json"), "utf8")).token).toBe(hubToken);
  });

  it("uses a stored token whose audience already names this API, without network", async () => {
    const token = jwt({ aud: [HUB, WORK] });
    file("token.json", { token, hub: HUB });
    planeDevice();

    expect((await resolveCredential())?.token).toBe(token);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the device secret only to an https plane", async () => {
    file("token.json", { token: jwt({ aud: HUB }), hub: HUB });
    planeDevice({ plane_url: "http://plane.example" });

    await expect(resolveCredential()).rejects.toThrow(/fleet login/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves a legacy (hub-mode) device on the hub's own renewal", async () => {
    // No plane_url: fleet logged in against the hub itself. Unchanged behaviour.
    file("device.json", { id: "dev_fixture", secret: "fixture-secret", hub: HUB });
    const token = jwt({});
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token })));

    expect((await resolveCredential())?.token).toBe(token);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${HUB}/api/auth/devices/token?client=apn`);
  });
});
