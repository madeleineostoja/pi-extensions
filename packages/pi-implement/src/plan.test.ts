import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it("builds an index task packet with exact raw material and no sibling escape hatches", () => {
    const dir = makeTmpDir();
    const planPathLocal = join(dir, "plan.md");
    const aDir = join(dir, "a");
    const bDir = join(dir, "b");
    const aPath = join(aDir, "spec.md");
    const bPath = join(bDir, "spec.md");
    mkdirSync(aDir, { recursive: true });
    mkdirSync(bDir, { recursive: true });
    writeFileSync(
      planPathLocal,
      `# Plan

## Context

Shared background.

## Tasks

- [ ] Implement selected slice
  - Plan: \`a/spec.md\`
  - Plan: \`b/spec.md\`
  - Keep this selected-task note.
- [ ] Implement sibling slice
  - Sibling-only requirement.
`,
      "utf-8",
    );
    writeFileSync(aPath, "# A Spec\n\nExact **markdown** A.\n", "utf-8");
    writeFileSync(bPath, "# B Spec\n\nExact `markdown` B.\n", "utf-8");
    const parsed = parsePlan(
      planPathLocal,
      readFileSync(planPathLocal, "utf-8"),
    );
    const manifest = buildPlanBundleManifest(planPathLocal, parsed);

    const packet = buildTaskPacket(parsed, parsed.tasks[0], manifest);

    expect(packet.markdown).toContain(
      "## Selected Task\n\n- [ ] Implement selected slice",
    );
    expect(packet.markdown).toContain("  - Keep this selected-task note.");
    expect(packet.markdown).toContain(
      "### a/spec.md\n\n# A Spec\n\nExact **markdown** A.\n",
    );
    expect(packet.markdown).toContain(
      "### b/spec.md\n\n# B Spec\n\nExact `markdown` B.\n",
    );
    expect(packet.markdown).toContain("## Background Context");
    expect(packet.markdown).toContain("Shared background.");
    expect(packet.markdown).not.toContain("Plan: `a/spec.md`");
    expect(packet.markdown).not.toContain("Plan: `b/spec.md`");
    expect(packet.markdown).not.toContain("Implement sibling slice");
    expect(packet.markdown).not.toContain("Sibling-only requirement");
    expect(packet.markdown).not.toContain("## Source Plan");
    expect(packet.markdown).not.toContain(planPathLocal);
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

  it("throws when a manifest is missing the selected task", () => {
    const dir = makeTmpDir();
    const planPathLocal = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      planPathLocal,
      `# Plan

## Tasks

- [ ] First task
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
    const altered = parsePlan(
      planPathLocal,
      `# Plan

## Tasks

- [x] First task
  - Plan: \`sub.md\`
- [ ] Added task
  - Plan: \`sub.md\`
`,
    );

    expect(() => buildTaskPacket(altered, altered.tasks[1], manifest)).toThrow(
      "missing from the plan bundle manifest",
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
