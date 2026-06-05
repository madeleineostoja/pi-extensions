import { describe, expect, it } from "vitest";
import { buildTaskPacket, markTaskDoneInContent, parsePlan } from "./plan.js";

const planPath = "/repo/tmp/plans/index.md";

describe("parsePlan", () => {
  it("requires a tasks section", () => {
    expect(() => parsePlan(planPath, "# Plan\n\n- [ ] nope\n")).toThrow(
      "## Tasks",
    );
  });

  it("parses only minimum-indent checkboxes in the tasks section", () => {
    const parsed = parsePlan(
      planPath,
      `# Plan

- [ ] acceptance outside

## Tasks

- [x] Done task
  - [ ] nested item
  - Plan: \`supporting file.md\`
- [ ] Next task

## Acceptance Criteria

- [ ] not executable
`,
    );

    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[0]).toMatchObject({
      checked: true,
      lineNumber: 7,
      text: "Done task",
    });
    expect(parsed.tasks[0].blockLines).toContain("  - [ ] nested item");
    expect(parsed.tasks[0].blockLines).toContain(
      "  - Plan: `supporting file.md`",
    );
    expect(parsed.tasks[1]).toMatchObject({
      checked: false,
      text: "Next task",
    });
  });

  it("marks exactly one task done", () => {
    const content = `# Plan

## Tasks

- [ ] First
- [ ] Second
`;
    const parsed = parsePlan(planPath, content);
    expect(markTaskDoneInContent(content, parsed.tasks[1])).toBe(`# Plan

## Tasks

- [ ] First
- [x] Second
`);
  });
});

describe("buildTaskPacket", () => {
  it("includes non-task context for single-file plans", () => {
    const parsed = parsePlan(
      planPath,
      `# Plan

## Context

Important.

## Tasks

- [ ] Do it
`,
    );
    const packet = buildTaskPacket(parsed, parsed.tasks[0]);
    expect(packet.markdown).toContain("## Selected Task\n\n- [ ] Do it");
    expect(packet.markdown).toContain(
      "## Background Plan Context (not additional selected-task scope)",
    );
    expect(packet.markdown).toContain("## Context\n\nImportant.");
  });
});
