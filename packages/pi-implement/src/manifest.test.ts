import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPlanBundleManifest,
  checkPlanMaterialSize,
  computeTaskFingerprint,
  extractPlanReference,
  formatBundleMaterial,
  formatReferencedMaterial,
  isPlanLinkageLine,
  MAX_PLAN_MATERIAL_CHARS,
  PlanMaterialSizeError,
  validatePlanMaterialSizes,
} from "./manifest.js";
import { parsePlan } from "./plan.js";

describe("MAX_PLAN_MATERIAL_CHARS", () => {
  it("is 100_000", () => {
    expect(MAX_PLAN_MATERIAL_CHARS).toBe(100_000);
  });
});

describe("extractPlanReference", () => {
  it("extracts backtick target", () => {
    expect(extractPlanReference("  - Plan: `foo.md`")).toEqual({
      target: "foo.md",
    });
  });

  it("extracts angle-bracket target", () => {
    expect(extractPlanReference("  - Plan: <bar.md>")).toEqual({
      target: "bar.md",
    });
  });

  it("returns undefined for non-Plan lines", () => {
    expect(extractPlanReference("  - Some note")).toBeUndefined();
  });

  it("returns undefined for malformed Plan lines with extra text", () => {
    expect(extractPlanReference("  - Plan: `foo.md` and more")).toBeUndefined();
  });

  it("returns undefined for multiple backtick targets on one line", () => {
    expect(extractPlanReference("  - Plan: `foo.md` `bar.md`")).toBeUndefined();
  });

  it("returns undefined for multiple angle targets on one line", () => {
    expect(extractPlanReference("  - Plan: <foo.md> <bar.md>")).toBeUndefined();
  });

  it("returns undefined for mixed format on one line", () => {
    expect(extractPlanReference("  - Plan: `foo.md` <bar.md>")).toBeUndefined();
  });

  it("returns undefined for empty backticks", () => {
    expect(extractPlanReference("  - Plan: ``")).toBeUndefined();
  });

  it("returns undefined for empty angle brackets", () => {
    expect(extractPlanReference("  - Plan: <>")).toBeUndefined();
  });
});

describe("isPlanLinkageLine", () => {
  it("identifies Plan: lines", () => {
    expect(isPlanLinkageLine("  - Plan: `foo.md`")).toBe(true);
    expect(isPlanLinkageLine("Plan: <foo.md>")).toBe(true);
  });

  it("rejects non-Plan lines", () => {
    expect(isPlanLinkageLine("  - Some note")).toBe(false);
    expect(isPlanLinkageLine("")).toBe(false);
  });
});

describe("computeTaskFingerprint", () => {
  const planPath = "/repo/plan.md";

  it("returns a full 64-character hex string", () => {
    const plan = parsePlan(planPath, "## Tasks\n\n- [ ] Do it\n  - note\n");
    const fp = computeTaskFingerprint(plan.tasks[0]);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is stable for identical tasks", () => {
    const content = "## Tasks\n\n- [ ] Do it\n  - note\n";
    const p1 = parsePlan(planPath, content);
    const p2 = parsePlan(planPath, content);
    expect(computeTaskFingerprint(p1.tasks[0])).toBe(
      computeTaskFingerprint(p2.tasks[0]),
    );
  });

  it("changes when title changes", () => {
    const p1 = parsePlan(planPath, "## Tasks\n\n- [ ] Do it\n");
    const p2 = parsePlan(planPath, "## Tasks\n\n- [ ] Do that\n");
    expect(computeTaskFingerprint(p1.tasks[0])).not.toBe(
      computeTaskFingerprint(p2.tasks[0]),
    );
  });

  it("changes when block lines change", () => {
    const p1 = parsePlan(planPath, "## Tasks\n\n- [ ] Do it\n  - note a\n");
    const p2 = parsePlan(planPath, "## Tasks\n\n- [ ] Do it\n  - note b\n");
    expect(computeTaskFingerprint(p1.tasks[0])).not.toBe(
      computeTaskFingerprint(p2.tasks[0]),
    );
  });

  it("is stable when checkbox state changes", () => {
    const p1 = parsePlan(planPath, "## Tasks\n\n- [ ] Do it\n  - note\n");
    const p2 = parsePlan(planPath, "## Tasks\n\n- [x] Do it\n  - note\n");
    expect(computeTaskFingerprint(p1.tasks[0])).toBe(
      computeTaskFingerprint(p2.tasks[0]),
    );
  });
});

describe("buildPlanBundleManifest", () => {
  const makeTmpDir = () => mkdtempSync(join(tmpdir(), "pi-manifest-"));

  it("produces no errors for a single-file plan without references", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Task\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.validationErrors).toHaveLength(0);
    expect(manifest.isIndexStyle).toBe(false);
    expect(manifest.allArtifactPaths).toEqual([planPath]);
    expect(manifest.tasks).toHaveLength(1);
    expect(manifest.tasks[0].referencedMaterials).toHaveLength(0);
  });

  it("resolves valid referenced material for index-style plans", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `sub.md`\n",
      "utf-8",
    );
    writeFileSync(subPath, "# Subplan\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.validationErrors).toHaveLength(0);
    expect(manifest.isIndexStyle).toBe(true);
    expect(manifest.allArtifactPaths).toContain(subPath);
    expect(manifest.tasks[0].referencedMaterials).toHaveLength(1);
    expect(manifest.tasks[0].referencedMaterials[0]).toMatchObject({
      absolutePath: subPath,
      displayLabel: "sub.md",
      content: "# Subplan\n",
    });
  });

  it("supports multiple Plan: lines per task", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const aPath = join(dir, "a.md");
    const bPath = join(dir, "b.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `a.md`\n  - Plan: <b.md>\n",
      "utf-8",
    );
    writeFileSync(aPath, "# A\n", "utf-8");
    writeFileSync(bPath, "# B\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.validationErrors).toHaveLength(0);
    expect(manifest.tasks[0].referencedMaterials).toHaveLength(2);
  });

  it("blocks multiple references on one line", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `a.md` `b.md`\n",
      "utf-8",
    );
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.validationErrors.length).toBeGreaterThan(0);
    expect(manifest.validationErrors[0]).toContain("malformed");
  });

  it("blocks URL targets", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `https://example.com/plan.md`\n",
      "utf-8",
    );
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.validationErrors.length).toBeGreaterThan(0);
    expect(manifest.validationErrors[0]).toContain("URL");
  });

  it("blocks non-markdown targets", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const txtPath = join(dir, "notes.txt");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `notes.txt`\n",
      "utf-8",
    );
    writeFileSync(txtPath, "not markdown", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.validationErrors.length).toBeGreaterThan(0);
    expect(manifest.validationErrors[0]).toContain("non-markdown");
  });

  it("blocks missing files", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `missing.md`\n",
      "utf-8",
    );
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.validationErrors.length).toBeGreaterThan(0);
    expect(manifest.validationErrors[0]).toContain("missing");
  });

  it("blocks empty files", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const emptyPath = join(dir, "empty.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `empty.md`\n",
      "utf-8",
    );
    writeFileSync(emptyPath, "   \n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.validationErrors.length).toBeGreaterThan(0);
    expect(manifest.validationErrors[0]).toContain("empty");
  });

  it("blocks directories", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    mkdirSync(join(dir, "subdir"));
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `subdir`\n",
      "utf-8",
    );
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.validationErrors.length).toBeGreaterThan(0);
    expect(manifest.validationErrors[0]).toContain("directory");
  });

  it("deduplicates artifact paths across tasks", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const sharedPath = join(dir, "shared.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task A\n  - Plan: `shared.md`\n- [ ] Task B\n  - Plan: `shared.md`\n",
      "utf-8",
    );
    writeFileSync(sharedPath, "# Shared\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.validationErrors).toHaveLength(0);
    expect(manifest.allArtifactPaths).toHaveLength(2); // plan + shared once
  });

  it("uses basename as display label by default", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const subPath = join(dir, "docs", "auth.md");
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `docs/auth.md`\n",
      "utf-8",
    );
    writeFileSync(subPath, "# Auth\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.tasks[0].referencedMaterials[0].displayLabel).toBe(
      "auth.md",
    );
  });

  it("uses relative path when basenames collide", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const aPath = join(dir, "a", "auth.md");
    const bPath = join(dir, "b", "auth.md");
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `a/auth.md`\n  - Plan: `b/auth.md`\n",
      "utf-8",
    );
    writeFileSync(aPath, "# A\n", "utf-8");
    writeFileSync(bPath, "# B\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    const labels = manifest.tasks[0].referencedMaterials.map(
      (m) => m.displayLabel,
    );
    expect(labels).toContain("a/auth.md");
    expect(labels).toContain("b/auth.md");
  });

  it("includes task fingerprints in the manifest", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Task\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.tasks[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not treat non-reference Plan: notes as malformed", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: review this with the team\n  - Plan: schedule a follow-up meeting\n",
      "utf-8",
    );
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.validationErrors).toHaveLength(0);
    expect(manifest.isIndexStyle).toBe(false);
    expect(manifest.tasks[0].referencedMaterials).toHaveLength(0);
  });

  it("blocks empty backtick reference attempts", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: ``\n",
      "utf-8",
    );
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.validationErrors.length).toBeGreaterThan(0);
    expect(manifest.validationErrors[0]).toContain("malformed");
  });

  it("blocks empty angle-bracket reference attempts", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: <>\n",
      "utf-8",
    );
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(manifest.validationErrors.length).toBeGreaterThan(0);
    expect(manifest.validationErrors[0]).toContain("malformed");
  });
});

describe("formatReferencedMaterial", () => {
  it("returns empty string for no materials", () => {
    expect(formatReferencedMaterial([])).toBe("");
  });

  it("includes raw content with display label headings", () => {
    const materials = [
      { absolutePath: "/a.md", displayLabel: "a.md", content: "# A\n" },
      { absolutePath: "/b.md", displayLabel: "b.md", content: "# B\n" },
    ];
    const formatted = formatReferencedMaterial(materials);
    expect(formatted).toContain("### a.md");
    expect(formatted).toContain("# A");
    expect(formatted).toContain("### b.md");
    expect(formatted).toContain("# B");
  });

  it("throws when content exceeds maxChars", () => {
    expect(() =>
      formatReferencedMaterial(
        [{ absolutePath: "/a.md", displayLabel: "a.md", content: "x" }],
        1,
      ),
    ).toThrow("Plan material exceeds maximum size");
  });
});

describe("formatBundleMaterial", () => {
  const makeTmpDir = () => mkdtempSync(join(tmpdir(), "pi-manifest-fmt-"));

  it("returns empty string for a manifest with no references", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Task\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(formatBundleMaterial(manifest)).toBe("");
  });

  it("deduplicates referenced materials across tasks", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const sharedPath = join(dir, "shared.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task A\n  - Plan: `shared.md`\n- [ ] Task B\n  - Plan: `shared.md`\n",
      "utf-8",
    );
    writeFileSync(sharedPath, "# Shared\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    const formatted = formatBundleMaterial(manifest);
    const occurrences = formatted.split("### shared.md").length - 1;
    expect(occurrences).toBe(1);
    expect(formatted).toContain("# Shared");
  });

  it("throws when content exceeds maxChars", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `sub.md`\n",
      "utf-8",
    );
    writeFileSync(subPath, "# Sub\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);
    expect(() => formatBundleMaterial(manifest, 1)).toThrow(
      "Plan material exceeds maximum size",
    );
  });
});

describe("checkPlanMaterialSize", () => {
  it("does not throw for content within limit", () => {
    expect(() => checkPlanMaterialSize("abc", 100)).not.toThrow();
  });

  it("throws for content exceeding limit", () => {
    expect(() => checkPlanMaterialSize("abc", 2)).toThrow(
      "Plan material exceeds maximum size",
    );
    expect(() => checkPlanMaterialSize("abc", 2)).toThrow(
      PlanMaterialSizeError,
    );
  });
});

describe("validatePlanMaterialSizes", () => {
  it("returns no errors when bundle and task material fit", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-manifest-size-"));
    const planPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `sub.md`\n",
      "utf-8",
    );
    writeFileSync(subPath, "# Sub\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);

    expect(validatePlanMaterialSizes(manifest)).toEqual([]);
  });

  it("returns clear errors when bundle or task material exceeds the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-manifest-size-"));
    const planPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `sub.md`\n",
      "utf-8",
    );
    writeFileSync(subPath, "# Sub\n", "utf-8");
    const plan = parsePlan(planPath, readFileSync(planPath, "utf-8"));
    const manifest = buildPlanBundleManifest(planPath, plan);

    const errors = validatePlanMaterialSizes(manifest, 1);

    expect(errors).toEqual([
      expect.stringContaining("bundle referenced plan material"),
      expect.stringContaining("task 1 referenced plan material"),
    ]);
    expect(errors.join("\n")).toContain("Plan material exceeds maximum size");
  });
});
