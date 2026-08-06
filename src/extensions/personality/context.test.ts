import { describe, expect, it } from "vitest";
import {
  changedFiles,
  compactRelativeTime,
  parseRecentCommits,
} from "./context.js";

describe("Personality context", () => {
  it("counts ordinary, untracked, and renamed changed files once", () => {
    const output = [
      " M src/extensions/personality/welcome.ts",
      "?? docs/features/interface-and-personality.md",
      "R  src/old.ts",
      "src/new.ts",
      "",
    ].join("\0");

    expect(changedFiles(output)).toEqual({
      count: 3,
      areas: ["src/extensions", "docs/features", "src/old.ts"],
    });
  });

  it("bounds normalized recent commit metadata and formats stable relative time", () => {
    const commits = parseRecentCommits(
      "first   commit\x1f2026-01-01T00:00:00.000Z\x1esecond commit\x1f2026-01-02T00:00:00.000Z\x1ethird\x1f2026-01-03T00:00:00.000Z\x1efourth\x1f2026-01-04T00:00:00.000Z",
    );

    expect(commits).toHaveLength(3);
    expect(commits[0]?.subject).toBe("first commit");
    expect(
      compactRelativeTime(
        new Date("2026-01-01T00:00:00.000Z"),
        Date.parse("2026-01-01T20:00:00.000Z"),
      ),
    ).toBe("20h ago");
  });
});
