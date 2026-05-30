import { describe, expect, it } from "vitest";
import { resolvePlanArtifacts } from "./artifacts.js";
import { parsePlan } from "./plan.js";

const planPath = "/repo/tmp/plans/index.md";

describe("resolvePlanArtifacts", () => {
  it("always includes the source plan", () => {
    const plan = parsePlan(planPath, "# Plan\n\n## Tasks\n\n- [ ] Task\n");
    const artifacts = resolvePlanArtifacts(planPath, plan);
    expect(artifacts).toContain("/repo/tmp/plans/index.md");
  });

  it("includes referenced markdown files from task blocks", () => {
    const plan = parsePlan(
      planPath,
      `# Plan

## Tasks

- [ ] Task one
  - Plan: \`sub/plan.md\`
- [ ] Task two
  - Plan: <other/deep.md>
`,
    );
    const artifacts = resolvePlanArtifacts(planPath, plan);
    expect(artifacts).toContain("/repo/tmp/plans/index.md");
    expect(artifacts).toContain("/repo/tmp/plans/sub/plan.md");
    expect(artifacts).toContain("/repo/tmp/plans/other/deep.md");
  });

  it("ignores URLs", () => {
    const plan = parsePlan(
      planPath,
      `# Plan

## Tasks

- [ ] Task
  - Plan: \`https://example.com/plan.md\`
  - Plan: <http://example.com/other.md>
`,
    );
    const artifacts = resolvePlanArtifacts(planPath, plan);
    expect(artifacts).toEqual(["/repo/tmp/plans/index.md"]);
  });

  it("ignores non-markdown references", () => {
    const plan = parsePlan(
      planPath,
      `# Plan

## Tasks

- [ ] Task
  - Plan: \`notes.txt\`
`,
    );
    const artifacts = resolvePlanArtifacts(planPath, plan);
    expect(artifacts).toEqual(["/repo/tmp/plans/index.md"]);
  });

  it("resolves absolute paths", () => {
    const plan = parsePlan(
      planPath,
      `# Plan

## Tasks

- [ ] Task
  - Plan: \`/absolute/path.md\`
`,
    );
    const artifacts = resolvePlanArtifacts(planPath, plan);
    expect(artifacts).toContain("/absolute/path.md");
  });

  it("handles artifacts outside the repo", () => {
    const plan = parsePlan(
      planPath,
      `# Plan

## Tasks

- [ ] Task
  - Plan: \`../../outside.md\`
`,
    );
    const artifacts = resolvePlanArtifacts(planPath, plan);
    expect(artifacts).toContain("/repo/outside.md");
  });
});
