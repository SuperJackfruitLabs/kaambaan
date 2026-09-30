/**
 * Telling a positional from a flag's value.
 *
 * `const pos = rest.filter((a) => !a.startsWith("--"))` drops the flag but keeps what follows it,
 * so `create-card <board> "A title" --spec ./spec.json` read the spec's PATH as part of the title
 * and produced a card called "A title ./spec.json". Every verb before it happened to read `pos[0]`
 * only, which is why the same filter had been correct by luck rather than by construction.
 *
 * Lives in its own module because `index.ts` ends in `await main(...)`: importing it to test a
 * helper would run the CLI.
 */
import { describe, expect, it } from "vitest";

import { flag, flags, positionals } from "./args";

describe("flag", () => {
  it("reads both spellings", () => {
    expect(flag(["--spec", "a.json"], "--spec")).toBe("a.json");
    expect(flag(["--spec=a.json"], "--spec")).toBe("a.json");
  });

  it("is null when absent, and when a flag is followed by another flag", () => {
    expect(flag(["--json"], "--spec")).toBe(null);
    expect(flag(["--spec", "--json"], "--spec")).toBe(null);
  });
});

describe("flags", () => {
  // `--label` is the one repeatable flag on this surface (`create-card`), and `flag` only ever
  // reads the first occurrence — `supi create-card b t --label a --label b` needs both.
  it("collects every occurrence, in either spelling", () => {
    expect(flags(["--label", "lbl_a", "--label", "lbl_b"], "--label")).toEqual(["lbl_a", "lbl_b"]);
    expect(flags(["--label=lbl_a", "--label=lbl_b"], "--label")).toEqual(["lbl_a", "lbl_b"]);
    expect(flags(["--label", "lbl_a", "--label=lbl_b"], "--label")).toEqual(["lbl_a", "lbl_b"]);
  });

  it("is empty when absent, and skips a bare flag followed by another flag", () => {
    expect(flags(["--json"], "--label")).toEqual([]);
    expect(flags(["--label", "--json"], "--label")).toEqual([]);
  });
});

describe("positionals", () => {
  it("skips the value a flag consumed", () => {
    expect(positionals(["brd_1", "A title", "--spec", "spec.json"])).toEqual(["brd_1", "A title"]);
  });

  it("skips nothing for a flag that takes no value", () => {
    // `--json` is the one valueless flag on this surface, so a positional after it is a positional.
    expect(positionals(["brd_1", "--json", "A title"])).toEqual(["brd_1", "A title"]);
  });

  it("handles the joined spelling, which consumes nothing", () => {
    expect(positionals(["brd_1", "--spec=spec.json", "A title"])).toEqual(["brd_1", "A title"]);
  });

  it("keeps a title that merely looks like a path", () => {
    // The bug was never about the shape of the value — only about its position.
    expect(positionals(["brd_1", "./notes.md"])).toEqual(["brd_1", "./notes.md"]);
  });

  it("skips the value of a repeated flag, once per occurrence", () => {
    expect(positionals(["brd_1", "A title", "--label", "lbl_a", "--label", "lbl_b"])).toEqual([
      "brd_1",
      "A title",
    ]);
  });
});
