import { describe, expect, it } from "vitest";
import { parsePlan } from "./plan.js";

const planPath = "/repo/tmp/plans/index.md";

describe("parsePlan", () => {
  it("fails actionably when no checkbox task section exists", () => {
    expect(() => parsePlan(planPath, "# Plan\n\nWrite some code.\n")).toThrow(
      "No checkbox task section found",
    );
  });

  it("parses the only checkbox-containing section without requiring a Tasks heading", () => {
    const parsed = parsePlan(
      planPath,
      `# Plan

## Implementation tasks

- [x] Done task
  - [ ] nested item
  - supporting detail
- [ ] Next task

## Acceptance Criteria

No checkboxes here.
`,
    );

    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0]).toMatchObject({
      checked: true,
      lineNumber: 5,
      text: "Done task",
    });
    expect(parsed.tasks[0].blockLines).toContain("  - [ ] nested item");
    expect(parsed.tasks[0].blockLines).toContain("  - supporting detail");
    expect(parsed.tasks[1]).toMatchObject({
      checked: false,
      text: "Next task",
    });
  });

  it("parses headingless content when it is the only checkbox section", () => {
    const parsed = parsePlan(
      planPath,
      `Intro prose.

- [ ] First task
* [X] Second task
`,
    );

    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0]).toMatchObject({
      checked: false,
      lineNumber: 3,
      text: "First task",
    });
    expect(parsed.tasks[1]).toMatchObject({
      checked: true,
      lineNumber: 4,
      text: "Second task",
    });
  });

  it("fails actionably when multiple sections contain checkbox candidates", () => {
    expect(() =>
      parsePlan(
        planPath,
        `# Plan

- [ ] top-level checkbox

## Implementation tasks

- [ ] task checkbox

## Acceptance Criteria

- [x] acceptance checkbox
`,
      ),
    ).toThrow("Multiple checkbox task sections found");
  });
});
