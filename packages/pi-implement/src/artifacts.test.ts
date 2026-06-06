import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePlanArtifacts } from "./artifacts.js";
import { parsePlan } from "./plan.js";

describe("resolvePlanArtifacts", () => {
  const makeTmpDir = () => mkdtempSync(join(tmpdir(), "pi-artifacts-"));

  it("always includes the source plan", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "index.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Task\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const artifacts = resolvePlanArtifacts(planPath, plan);
    expect(artifacts).toContain(planPath);
  });

  it("includes referenced markdown files from task blocks", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "index.md");
    const subPath = join(dir, "sub", "plan.md");
    const otherPath = join(dir, "other", "deep.md");
    mkdirSync(join(dir, "sub"), { recursive: true });
    mkdirSync(join(dir, "other"), { recursive: true });
    writeFileSync(
      planPath,
      `# Plan\n\n## Tasks\n\n- [ ] Task one\n  - Plan: \`sub/plan.md\`\n- [ ] Task two\n  - Plan: <other/deep.md>\n`,
      "utf-8",
    );
    writeFileSync(subPath, "# Sub\n", "utf-8");
    writeFileSync(otherPath, "# Other\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const artifacts = resolvePlanArtifacts(planPath, plan);
    expect(artifacts).toContain(planPath);
    expect(artifacts).toContain(subPath);
    expect(artifacts).toContain(otherPath);
  });

  it("throws for URL targets", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "index.md");
    writeFileSync(
      planPath,
      `# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: \`https://example.com/plan.md\`\n  - Plan: <http://example.com/other.md>\n`,
      "utf-8",
    );
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    expect(() => resolvePlanArtifacts(planPath, plan)).toThrow("URL");
  });

  it("throws for non-markdown references", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "index.md");
    const txtPath = join(dir, "notes.txt");
    writeFileSync(
      planPath,
      `# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: \`notes.txt\`\n`,
      "utf-8",
    );
    writeFileSync(txtPath, "not markdown", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    expect(() => resolvePlanArtifacts(planPath, plan)).toThrow("non-markdown");
  });

  it("resolves absolute paths", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "index.md");
    const absPath = join(dir, "absolute", "path.md");
    mkdirSync(join(dir, "absolute"), { recursive: true });
    writeFileSync(
      planPath,
      `# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: \`${absPath}\`\n`,
      "utf-8",
    );
    writeFileSync(absPath, "# Abs\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const artifacts = resolvePlanArtifacts(planPath, plan);
    expect(artifacts).toContain(absPath);
  });

  it("handles artifacts outside the immediate plan dir", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plans", "index.md");
    const outsidePath = join(dir, "sibling.md");
    mkdirSync(join(dir, "plans"), { recursive: true });
    writeFileSync(
      planPath,
      `# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: \`../sibling.md\`\n`,
      "utf-8",
    );
    writeFileSync(outsidePath, "# Sibling\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const artifacts = resolvePlanArtifacts(planPath, plan);
    expect(artifacts).toContain(outsidePath);
  });

  it("throws for multiple references on one line", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "index.md");
    writeFileSync(
      planPath,
      `# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: \`a.md\` \`b.md\`\n`,
      "utf-8",
    );
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    expect(() => resolvePlanArtifacts(planPath, plan)).toThrow("malformed");
  });

  it("throws for missing referenced files", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "index.md");
    writeFileSync(
      planPath,
      `# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: \`missing.md\`\n`,
      "utf-8",
    );
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    expect(() => resolvePlanArtifacts(planPath, plan)).toThrow("missing");
  });
});
