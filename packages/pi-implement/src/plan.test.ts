import { describe, expect, it } from "vitest";
import {
  markTaskDoneInContent,
  markTaskUndoneInContent,
  parsePlan,
} from "./plan.js";
import { computeTaskFingerprint } from "./manifest.js";

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

  it("throws when the exact line no longer matches", () => {
    const content = `# Plan

## Tasks

- [ ] First
- [ ] Second
`;
    const parsed = parsePlan(planPath, content);
    const modified = content.replace("- [ ] Second", "- [ ] Edited");
    expect(() => markTaskDoneInContent(modified, parsed.tasks[1])).toThrow(
      "Stale source checkbox",
    );
  });

  it("normalizes checkbox marker so undo works after marking done", () => {
    const content = `# Plan

## Tasks

- [ ] First
- [ ] Second
`;
    const parsed = parsePlan(planPath, content);
    const done = markTaskDoneInContent(content, parsed.tasks[1]);
    expect(done).toBe(`# Plan

## Tasks

- [ ] First
- [x] Second
`);
    const undone = markTaskUndoneInContent(done, parsed.tasks[1]);
    expect(undone).toBe(content);
  });
});

describe("computeTaskFingerprint integration", () => {
  it("computes a stable full-hex fingerprint for parsed tasks", () => {
    const parsed = parsePlan(planPath, `## Tasks\n\n- [ ] Do it\n  - note\n`);
    const fp = computeTaskFingerprint(parsed.tasks[0]);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is stable across checkbox state changes", () => {
    const unchecked = parsePlan(planPath, `## Tasks\n\n- [ ] Do it\n`);
    const checked = parsePlan(planPath, `## Tasks\n\n- [x] Do it\n`);
    expect(computeTaskFingerprint(unchecked.tasks[0])).toBe(
      computeTaskFingerprint(checked.tasks[0]),
    );
  });
});
