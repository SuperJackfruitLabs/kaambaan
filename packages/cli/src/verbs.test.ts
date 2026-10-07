/**
 * The verbs this CLI dispatches, checked against the verbs it advertises.
 *
 * Read from the source rather than from an exported table, because `index.ts` exports nothing and
 * the alternative — exporting a list so a test can read it — would be a second copy of the switch
 * to keep in step. This mirrors `agentpod/apps/node-agent/cmd/agentpod-fleet/main_test.go`, which
 * reads `fleet.go` for the same reason and for the same failure: a verb in the help and not in the
 * dispatch is a documented command that does nothing, and a verb dispatched and not in the help is
 * a capability nobody can find.
 *
 * Both directions are asserted. Checking only one is how the drift starts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "./commands.ts";

const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");

/**
 * Every `case "<verb>":` in main's switch, minus the help aliases.
 *
 * `help`, `-h` and `--help` are excluded for the reason agentpod's equivalent test gives about its
 * own: they print the usage rather than name a thing the CLI does, so a usage block that does not
 * advertise `supi help` is not drift. Everything else must appear on both sides.
 */
function dispatched(): Set<string> {
  const all = [...source.matchAll(/^\s{4}case "([a-z-]+)":/gm)].map((m) => m[1]);
  return new Set(all.filter((v) => v !== "-h" && v !== "--help"));
}

/**
 * Every verb the help advertises. The USAGE block is rendered from `commands.ts` now, so that table
 * is what `supi help` shows; `reference.test.ts` holds it to the switch sub-verb by sub-verb.
 */
function listed(): Set<string> {
  return new Set(COMMANDS.map((c) => c.path[0]!));
}

describe("verb surface", () => {
  it("dispatches the work verbs that make a board usable from a terminal", () => {
    const got = dispatched();
    for (const verb of ["whoami", "boards", "board", "card", "move", "gates", "create-board", "templates"]) {
      expect(got.has(verb), `${verb} is not dispatched`).toBe(true);
    }
  });

  it("dispatches the writes that make a board reach a working state", () => {
    // A board whose lanes are wrong and a board with no cards are both unusable, and both were
    // only fixable in a browser. `create-board` already proved the whole `/v1/boards/**` surface
    // accepts a hub token for any method — these two are the rest of that surface.
    //
    // `create-card` in particular is the better way in: a card carries the authority that queued
    // it, and a session-cookie caller carries none — "which is refused under enforcement rather
    // than treated as an empty grant". A card queued with this token is claimable; one queued from
    // the web app without a hub token parks in `input-required` and says why.
    const got = dispatched();
    for (const verb of ["set-stages", "create-card"]) {
      expect(got.has(verb), `${verb} is not dispatched`).toBe(true);
    }
  });

  it("dispatches the label verb, so the drawer's Labels input has a catalogue to resolve against", () => {
    // `supi label list|add|rm` hits the Task 4 routes (`/v1/labels[/:id]`) — the same catalogue
    // `resolveLabelNames` resolves a card's free-text labels against server-side.
    const got = dispatched();
    expect(got.has("label"), "label is not dispatched").toBe(true);
  });

  it("dispatches the registry reads a board's routing depends on", () => {
    // Routing is exact string equality between a stage's `owner` and an agent's EFFECTIVE
    // capability set. When a card does not move, the whole diagnosis is that comparison — so the
    // two sides of it, and the implication edges between them, have to be readable from here.
    // Without these, a lane nothing can claim is invisible until someone opens the web app.
    const got = dispatched();
    for (const verb of ["agents", "capabilities", "implications"]) {
      expect(got.has(verb), `${verb} is not dispatched`).toBe(true);
    }
  });

  it("dispatches the verb that bounds what an agent may queue", () => {
    // Migration 0015 shipped three columns, the route that READS them, and for one commit nothing
    // that could write them — so a coordinator's blast radius could only be set by opening a
    // database. A permission whose only setter is a SQL prompt is a permission nobody audits, and
    // it is also one `Route everything through Claude` forbids handing back as a manual step.
    expect(dispatched().has("agent"), "agent is not dispatched").toBe(true);
  });

  it("lists exactly what it dispatches, in both directions", () => {
    expect([...listed()].sort()).toEqual([...dispatched()].sort());
  });
});
