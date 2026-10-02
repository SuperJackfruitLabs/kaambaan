/**
 * The skill ships beside the CLI, so it is checked against the CLI.
 *
 * `skills/superpipeline-boards/SKILL.md` tells an agent which verbs exist. It lives in this package
 * rather than on a server because a skill hand-placed next to a binary drifts from it the moment a
 * verb is renamed — and a skill is read by something that cannot notice. This is the same argument
 * `verbs.test.ts` already makes about the usage block: "a verb in the help and not in the dispatch
 * is a documented command that does nothing".
 *
 * Both directions are NOT asserted here, deliberately. A skill is a curated subset — it should not
 * list `supi update`, `supi forge` or `supi milestone rm` — so "every dispatched verb appears in the
 * skill" would be wrong. What must hold is the other direction: nothing the skill tells an agent to
 * run may be absent.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
const skill = readFileSync(
  join(import.meta.dirname, "..", "skills", "superpipeline-boards", "SKILL.md"),
  "utf8",
);

/** Every `case "<verb>":` in main's switch. */
function dispatched(): Set<string> {
  return new Set([...source.matchAll(/^\s{4}case "([a-z-]+)":/gm)].map((m) => m[1]!));
}

/** Every `supi <verb>` the skill tells an agent to run. */
function taught(): Set<string> {
  return new Set([...skill.matchAll(/\bsupi ([a-z][a-z-]*)/g)].map((m) => m[1]!));
}

describe("the superpipeline-boards skill", () => {
  it("carries the frontmatter a hermes skill is discovered by", () => {
    // Without `name` and `description` the file is a document nothing loads. The description is
    // what decides whether the skill is reached for at all, so it names the questions rather than
    // the tool.
    expect(skill).toMatch(/^---\n/);
    expect(skill).toMatch(/^name: superpipeline-boards$/m);
    expect(skill).toMatch(/^description: ".+"$/m);
  });

  it("teaches no verb this CLI does not dispatch", () => {
    const missing = [...taught()].filter((v) => !dispatched().has(v));
    expect(missing, `the skill names verbs that do not exist: ${missing.join(", ")}`).toEqual([]);
  });

  it("teaches the reads a coordinator actually needs", () => {
    // The point of the skill. An agent that cannot answer "what is stuck" from the board has to
    // guess, and a guess reported as a fact is the failure this whole surface exists to remove.
    for (const verb of ["whoami", "boards", "board", "card", "gates", "agents"]) {
      expect(taught().has(verb), `${verb} is not taught`).toBe(true);
    }
  });

  it("teaches the PLANNING surface, not only the reads", () => {
    /**
     * The omission this exists to stop, and it is not hypothetical.
     *
     * The coordinator surface shipped and this skill still described the world before it, so the
     * agent told its operator it had no project-creation access — correctly, by its instructions,
     * while the API answered 201. A capability nothing tells the agent about is a capability the
     * agent does not have, and the agent's own instructions are the consumer that was missing.
     */
    for (const verb of ["project", "milestone", "link", "move"]) {
      expect(taught().has(verb), `${verb} is not taught`).toBe(true);
    }
    // And the one fact that makes setting a project worth doing at all.
    expect(skill.toLowerCase()).toContain("rollup");
  });

  it("explains that raising a decision has a mechanism, since gates do not", () => {
    // "You cannot resolve a gate" on its own reads as a dead end, and an agent that believes it has
    // one stops. The mechanism — a card on a human-owned stage, plus a `blocks` link — has to travel
    // with the refusal, or the refusal is all the agent learns.
    expect(skill).toMatch(/blocks/);
    expect(skill.toLowerCase()).toMatch(/human half of the control pair/);
  });

  it("names the refusals by code, so a reader acts instead of retrying", () => {
    // Each of these is a distinct dead end with a distinct remedy, and the whole reason they are
    // separate codes is that an agent should be able to tell them apart without a human.
    for (const code of [
      "BOARD_NOT_PERMITTED",
      "AGENT_HAS_NO_OWNER",
      "NO_DISPATCH_AUTHORITY",
      "QUEUE_CEILING_REACHED",
      "DISPATCH_GRANT_UNKNOWN",
    ]) {
      expect(skill, `${code} is not explained`).toContain(code);
    }
  });

  it("tells the agent to check WHICH identity it is acting as", () => {
    // A station's shell can hold a leftover operator token. An agent that acts as the operator is
    // indistinguishable from the operator in the record, which is what `queued_by_agent_id` and the
    // `$SUPERPIPELINE_AGENT_TOKEN` precedence exist to prevent — so the skill opens with the check.
    expect(skill).toContain("SUPERPIPELINE_AGENT_TOKEN");
    expect(skill).toMatch(/kind agent/);
  });

  it("states what stays a person's, so the agent does not route around it", () => {
    for (const forbidden of ["gate", "stages", "credential"]) {
      expect(skill.toLowerCase()).toContain(forbidden);
    }
  });
});
