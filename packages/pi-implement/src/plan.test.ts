import { describe, expect, it } from "vitest";
import {
  markTaskDoneInContent,
  markTaskUndoneInContent,
  parsePlan,
} from "./plan.js";
import { computeTaskFingerprint } from "./manifest.js";

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
  - Plan: \`supporting file.md\`
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
    expect(parsed.tasks[0].blockLines).toContain(
      "  - Plan: `supporting file.md`",
    );
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
    ).toThrow(
      "Multiple checkbox task sections found. Keep executable task checkboxes in exactly one section, or remove checkboxes from the others. Candidates:\n- Plan (lines 1-4)\n- Implementation tasks (lines 5-8)\n- Acceptance Criteria (lines 9-12)",
    );
  });

  it("parses only minimum-indent checkboxes in the selected section", () => {
    const parsed = parsePlan(
      planPath,
      `# Plan

## Tasks

- [x] Done task
  - [ ] nested item
  - Plan: \`supporting file.md\`
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
