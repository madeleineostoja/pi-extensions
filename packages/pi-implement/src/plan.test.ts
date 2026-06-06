import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskPacket, markTaskDoneInContent, parsePlan } from "./plan.js";
import { buildPlanBundleManifest, computeTaskFingerprint } from "./manifest.js";

const planPath = "/repo/tmp/plans/index.md";

const makeTmpDir = () => mkdtempSync(join(tmpdir(), "pi-plan-test-"));

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
    expect(packet.markdown).toContain("## Background Context");
    expect(packet.markdown).toContain("## Context\n\nImportant.");
  });

  it("does not include source plan path", () => {
    const parsed = parsePlan(
      planPath,
      `## Tasks

- [ ] Do it
`,
    );
    const packet = buildTaskPacket(parsed, parsed.tasks[0]);
    expect(packet.markdown).not.toContain("## Source Plan");
    expect(packet.markdown).not.toContain(planPath);
  });

  it("strips Plan: linkage lines from selected task notes", () => {
    const dir = makeTmpDir();
    const planPathLocal = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      planPathLocal,
      `# Plan

## Tasks

- [ ] Do it
  - note one
  - Plan: \`sub.md\`
  - note two
`,
      "utf-8",
    );
    writeFileSync(subPath, "# Sub\n", "utf-8");
    const parsed = parsePlan(
      planPathLocal,
      readFileSync(planPathLocal, "utf-8"),
    );
    const manifest = buildPlanBundleManifest(planPathLocal, parsed);
    const packet = buildTaskPacket(parsed, parsed.tasks[0], manifest);
    expect(packet.markdown).toContain("## Selected Task Notes");
    expect(packet.markdown).toContain("  - note one");
    expect(packet.markdown).toContain("  - note two");
    expect(packet.markdown).not.toContain("Plan: `sub.md`");
  });

  it("includes referenced plan material when manifest is provided", () => {
    const dir = makeTmpDir();
    const planPathLocal = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      planPathLocal,
      `# Plan

## Tasks

- [ ] Do it
  - Plan: \`sub.md\`
`,
      "utf-8",
    );
    writeFileSync(subPath, "# Subplan content\n", "utf-8");
    const parsed = parsePlan(
      planPathLocal,
      readFileSync(planPathLocal, "utf-8"),
    );
    const manifest = buildPlanBundleManifest(planPathLocal, parsed);
    const packet = buildTaskPacket(parsed, parsed.tasks[0], manifest);
    expect(packet.markdown).toContain("## Referenced Plan Material");
    expect(packet.markdown).toContain("### sub.md");
    expect(packet.markdown).toContain("# Subplan content");
  });

  it("omits selected task notes section when there are no non-Plan notes", () => {
    const dir = makeTmpDir();
    const planPathLocal = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      planPathLocal,
      `# Plan

## Tasks

- [ ] Do it
  - Plan: \`sub.md\`
`,
      "utf-8",
    );
    writeFileSync(subPath, "# Sub\n", "utf-8");
    const parsed = parsePlan(
      planPathLocal,
      readFileSync(planPathLocal, "utf-8"),
    );
    const manifest = buildPlanBundleManifest(planPathLocal, parsed);
    const packet = buildTaskPacket(parsed, parsed.tasks[0], manifest);
    expect(packet.markdown).not.toContain("## Selected Task Notes");
  });

  it("throws on fingerprint mismatch", () => {
    const dir = makeTmpDir();
    const planPathLocal = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      planPathLocal,
      `# Plan

## Tasks

- [ ] Do it
  - Plan: \`sub.md\`
`,
      "utf-8",
    );
    writeFileSync(subPath, "# Sub\n", "utf-8");
    const parsed = parsePlan(
      planPathLocal,
      readFileSync(planPathLocal, "utf-8"),
    );
    const manifest = buildPlanBundleManifest(planPathLocal, parsed);
    // Simulate a plan change by altering the task text
    const altered = parsePlan(
      planPathLocal,
      `# Plan

## Tasks

- [ ] Do it changed
  - Plan: \`sub.md\`
`,
    );
    expect(() => buildTaskPacket(altered, altered.tasks[0], manifest)).toThrow(
      "fingerprint mismatch",
    );
  });

  it("preserves single-file behavior without manifest", () => {
    const parsed = parsePlan(
      planPath,
      `## Tasks

- [ ] Do it
  - note
`,
    );
    const packet = buildTaskPacket(parsed, parsed.tasks[0]);
    expect(packet.markdown).toContain("## Selected Task Notes");
    expect(packet.markdown).toContain("  - note");
    expect(packet.markdown).not.toContain("## Referenced Plan Material");
  });

  it("does not strip Plan: notes in single-file plans without a manifest", () => {
    const parsed = parsePlan(
      planPath,
      `## Tasks

- [ ] Do it
  - Plan: review this with the team
  - note two
`,
    );
    const packet = buildTaskPacket(parsed, parsed.tasks[0]);
    expect(packet.markdown).toContain("  - Plan: review this with the team");
    expect(packet.markdown).toContain("  - note two");
    expect(packet.markdown).not.toContain("## Referenced Plan Material");
  });

  it("preserves non-reference Plan: notes even when manifest is provided", () => {
    const dir = makeTmpDir();
    const planPathLocal = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      planPathLocal,
      `# Plan

## Tasks

- [ ] Do it
  - Plan: review this with the team
  - Plan: \`sub.md\`
  - note two
`,
      "utf-8",
    );
    writeFileSync(subPath, "# Sub\n", "utf-8");
    const parsed = parsePlan(
      planPathLocal,
      readFileSync(planPathLocal, "utf-8"),
    );
    const manifest = buildPlanBundleManifest(planPathLocal, parsed);
    const packet = buildTaskPacket(parsed, parsed.tasks[0], manifest);
    expect(packet.markdown).toContain("  - Plan: review this with the team");
    expect(packet.markdown).toContain("  - note two");
    expect(packet.markdown).not.toContain("Plan: `sub.md`");
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
