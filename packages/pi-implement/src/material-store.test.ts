import {
  mkdtempSync,
  writeFileSync,
  readFileSync as readFile,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePlan } from "./plan.js";
import {
  buildMaterialStore,
  formatStoreBundleMaterial,
  formatStoreCorpusMaterial,
  resolveMaterialRefPath,
} from "./material-store.js";
import { manifestFromStore } from "./manifest.js";
import { ingestPlanCorpusFromStore } from "./corpus.js";
import { buildPhase1MaterialInventory } from "./material-inventory.js";
import {
  buildDeterministicSourceMaterialRefs,
  renderSourceMaterialPacket,
} from "./execution-plan.js";

const makeTmpDir = () => mkdtempSync(join(tmpdir(), "pi-store-test-"));

describe("buildMaterialStore", () => {
  it("includes the entry plan and records hashes and line counts", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const planContent = "# Plan\n\n## Tasks\n\n- [ ] Task\n";
    writeFileSync(planPath, planContent, "utf-8");

    const plan = parsePlan(planPath, planContent);
    const store = buildMaterialStore({ plan, planPath });

    expect(store.entryPath).toBe(planPath);
    expect(store.files).toHaveLength(1);
    expect(store.files[0]).toMatchObject({
      absolutePath: planPath,
      displayPath: "plan.md",
      content: planContent,
      lineCount: 6,
      origins: ["entry-plan"],
    });
    expect(store.files[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(store.storeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(store.validationErrors).toHaveLength(0);
  });

  it("ingests Plan: links, task-block markdown links, and corpus links", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const planLinkPath = join(dir, "plan-link.md");
    const taskLinkPath = join(dir, "task-link.md");
    const corpusLinkPath = join(dir, "corpus-link.md");

    writeFileSync(
      planPath,
      [
        "# Plan",
        "",
        "See [corpus](corpus-link.md) for background.",
        "",
        "## Tasks",
        "",
        "- [ ] Task",
        "  - Plan: `plan-link.md`",
        "  Use [task material](task-link.md).",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(planLinkPath, "# Plan link\n", "utf-8");
    writeFileSync(taskLinkPath, "# Task link\n", "utf-8");
    writeFileSync(corpusLinkPath, "# Corpus link\n", "utf-8");

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath });

    const paths = store.files.map((f) => f.absolutePath);
    expect(paths).toContain(planPath);
    expect(paths).toContain(planLinkPath);
    expect(paths).toContain(taskLinkPath);
    expect(paths).toContain(corpusLinkPath);
    expect(store.validationErrors).toHaveLength(0);
  });

  it("rejects URL targets for packet material", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `https://example.com/plan.md`\n",
      "utf-8",
    );

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath });

    expect(store.validationErrors.length).toBeGreaterThan(0);
    expect(store.validationErrors[0]).toContain("URL");
  });

  it("reports invalid line-range refs through the same validation channel", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const materialPath = join(dir, "material.md");
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Task\n", "utf-8");
    writeFileSync(materialPath, "# Material\n", "utf-8");

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath });
    const inventory = buildPhase1MaterialInventory({ plan, planPath, store });
    const refs = buildDeterministicSourceMaterialRefs(plan.tasks[0], planPath);
    refs.push({
      origin: "planner",
      path: materialPath,
      mode: { kind: "line-range", startLine: 5, endLine: 10 },
      reason: "Out-of-range fixture.",
    });

    const packet = renderSourceMaterialPacket(refs, {
      resolvePath: (ref) => resolveMaterialRefPath(ref.path, store),
      readFileContent: ({ absolutePath }) => {
        const material = inventory.materials.find(
          (m) => m.absolutePath === absolutePath,
        );
        return material?.content ?? "";
      },
    });

    expect(packet).toBeDefined();
    expect(packet!.warnings.some((w) => w.includes("line range"))).toBe(true);
  });

  it("detects hash changes in frozen material", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const materialPath = join(dir, "material.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `material.md`\n",
      "utf-8",
    );
    writeFileSync(materialPath, "# Material\n", "utf-8");

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath });

    const file = store.files.find((f) => f.absolutePath === materialPath);
    expect(file).toBeDefined();

    writeFileSync(materialPath, "# Changed\n", "utf-8");
    const laterStore = buildMaterialStore({ plan, planPath });
    const laterFile = laterStore.files.find(
      (f) => f.absolutePath === materialPath,
    );
    expect(laterFile!.hash).not.toBe(file!.hash);
    expect(laterStore.storeHash).not.toBe(store.storeHash);
  });

  it("centralizes validation errors for malformed Plan: lines", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `a.md` `b.md`\n",
      "utf-8",
    );

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath });

    expect(store.validationErrors.length).toBeGreaterThan(0);
    expect(store.validationErrors[0]).toContain("malformed");
  });

  it("rejects corpus links that escape allowed roots", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plans", "plan.md");
    const outsidePath = join(dir, "outside.md");
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(
      planPath,
      "# Plan\n\nSee [outside](../outside.md).\n\n## Tasks\n\n- [ ] Task\n",
      "utf-8",
    );
    writeFileSync(outsidePath, "# Outside\n", "utf-8");

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath });

    expect(store.files.map((f) => f.absolutePath)).not.toContain(outsidePath);
    expect(store.validationErrors.length).toBeGreaterThan(0);
    expect(store.validationErrors[0]).toContain("escapes allowed root");
  });

  it("supports repo-root-relative Plan: links", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plans", "plan.md");
    const materialPath = join(dir, "material.md");
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `material.md`\n",
      "utf-8",
    );
    writeFileSync(materialPath, "# Material\n", "utf-8");

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath, repoRoot: dir });

    expect(store.files.map((f) => f.absolutePath)).toContain(materialPath);
    expect(store.validationErrors).toHaveLength(0);
  });

  it("supports repo-root-relative task-block markdown links", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plans", "plan.md");
    const materialPath = join(dir, "material.md");
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  Use [material](material.md).\n",
      "utf-8",
    );
    writeFileSync(materialPath, "# Material\n", "utf-8");

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath, repoRoot: dir });

    expect(store.files.map((f) => f.absolutePath)).toContain(materialPath);
    expect(store.validationErrors).toHaveLength(0);
  });

  it("supports repo-root-relative corpus links", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plans", "plan.md");
    const materialPath = join(dir, "material.md");
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(
      planPath,
      "# Plan\n\nSee [material](material.md).\n\n## Tasks\n\n- [ ] Task\n",
      "utf-8",
    );
    writeFileSync(materialPath, "# Material\n", "utf-8");

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath, repoRoot: dir });

    expect(store.files.map((f) => f.absolutePath)).toContain(materialPath);
    expect(store.validationErrors).toHaveLength(0);
  });

  it("resolves repo-root-relative planner refs when plan is in a subdirectory", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plans", "plan.md");
    const materialPath = join(dir, "docs", "context.md");
    mkdirSync(dirname(planPath), { recursive: true });
    mkdirSync(dirname(materialPath), { recursive: true });
    writeFileSync(
      planPath,
      "# Plan\n\nSee [context](../docs/context.md).\n\n## Tasks\n\n- [ ] Task\n",
      "utf-8",
    );
    writeFileSync(materialPath, "# Context\n", "utf-8");

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath, repoRoot: dir });

    const resolution = resolveMaterialRefPath("docs/context.md", store);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      return;
    }
    expect(resolution.absolutePath).toBe(materialPath);
  });

  it("blocks bare empty Plan: targets", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan:\n",
      "utf-8",
    );

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath });

    expect(store.validationErrors.length).toBeGreaterThan(0);
    expect(store.validationErrors[0]).toContain("empty Plan: target");
  });
});

describe("MaterialStore compatibility adapters", () => {
  it("manifest, corpus, and inventory adapters draw from the same store files", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    const corpusPath = join(dir, "corpus.md");
    writeFileSync(
      planPath,
      [
        "# Plan",
        "",
        "See [corpus](corpus.md) for background.",
        "",
        "## Tasks",
        "",
        "- [ ] Task",
        "  - Plan: `sub.md`",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(subPath, "# Sub\n", "utf-8");
    writeFileSync(corpusPath, "# Corpus\n", "utf-8");

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath });

    const manifest = manifestFromStore(store, plan);
    const corpus = ingestPlanCorpusFromStore(store);
    const inventory = buildPhase1MaterialInventory({ plan, planPath, store });

    expect(manifest.validationErrors).toEqual([]);
    expect(corpus.validationErrors).toEqual([]);

    const storePaths = store.files.map((f) => f.absolutePath);
    const manifestPaths = manifest.allArtifactPaths;
    const corpusPaths = corpus.files.map((f) => f.absolutePath);
    const inventoryPaths = inventory.materials.map((m) => m.absolutePath);

    expect(new Set(manifestPaths)).toEqual(
      new Set(storePaths.filter((p) => p === planPath || p === subPath)),
    );
    expect(new Set(corpusPaths)).toEqual(new Set(storePaths));
    expect(new Set(inventoryPaths)).toEqual(new Set(storePaths));
  });

  it("validation errors flow through the single store channel", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `missing.md`\n",
      "utf-8",
    );

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath });

    const manifest = manifestFromStore(store, plan);
    const corpus = ingestPlanCorpusFromStore(store);

    expect(store.validationErrors).toEqual(manifest.validationErrors);
    expect(corpus.validationErrors).toEqual([]);
  });
});

describe("MaterialStore prompt and packet rendering", () => {
  it("planner bundle and corpus material are sourced from the store", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const bundlePath = join(dir, "bundle.md");
    const corpusPath = join(dir, "corpus.md");
    writeFileSync(
      planPath,
      [
        "# Plan",
        "",
        "See [corpus](corpus.md).",
        "",
        "## Tasks",
        "",
        "- [ ] Task",
        "  - Plan: `bundle.md`",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(bundlePath, "# Bundle\n", "utf-8");
    writeFileSync(corpusPath, "# Corpus\n", "utf-8");

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath });

    const bundle = formatStoreBundleMaterial(store);
    const corpus = formatStoreCorpusMaterial(store);

    expect(bundle).toContain("### bundle.md");
    expect(bundle).toContain("# Bundle");
    expect(corpus).toContain("### corpus.md");
    expect(corpus).toContain("# Corpus");
  });

  it("task packet records resolved refs, hashes, and rendered character counts from the store", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const materialPath = join(dir, "material.md");
    writeFileSync(
      planPath,
      "# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: `material.md`\n",
      "utf-8",
    );
    writeFileSync(materialPath, "# Material\n\nDetails.\n", "utf-8");

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath });
    const inventory = buildPhase1MaterialInventory({ plan, planPath, store });
    const refs = buildDeterministicSourceMaterialRefs(plan.tasks[0], planPath);
    refs.push({
      origin: "task-link",
      path: materialPath,
      mode: { kind: "full-file" },
      reason:
        "Explicit local Markdown material linked from the selected task block.",
    });

    const packet = renderSourceMaterialPacket(refs, {
      resolvePath: (ref) => resolveMaterialRefPath(ref.path, store),
      readFileContent: ({ absolutePath }) => {
        const material = inventory.materials.find(
          (m) => m.absolutePath === absolutePath,
        );
        return material?.content ?? "";
      },
    });

    expect(packet).toBeDefined();
    const resolvedPaths = packet!.resolvedRefs.map((ref) => ref.absolutePath);
    expect(resolvedPaths).toContain(planPath);
    expect(resolvedPaths).toContain(materialPath);

    const materialRef = packet!.resolvedRefs.find(
      (ref) => ref.absolutePath === materialPath,
    )!;
    expect(materialRef).toMatchObject({
      origin: "task-link",
      mode: { kind: "full-file" },
    });
    expect(materialRef.fileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(materialRef.renderedContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(materialRef.renderedCharCount).toBeGreaterThan(0);
  });

  it("overall review material is sourced from the same store as planner prompt", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const bundlePath = join(dir, "bundle.md");
    const corpusPath = join(dir, "corpus.md");
    writeFileSync(
      planPath,
      [
        "# Plan",
        "",
        "See [corpus](corpus.md).",
        "",
        "## Tasks",
        "",
        "- [ ] Task",
        "  - Plan: `bundle.md`",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(bundlePath, "# Bundle\n", "utf-8");
    writeFileSync(corpusPath, "# Corpus\n", "utf-8");

    const plan = parsePlan(planPath, readFile(planPath, "utf-8"));
    const store = buildMaterialStore({ plan, planPath });

    const bundle = formatStoreBundleMaterial(store);
    const corpus = formatStoreCorpusMaterial(store);

    const bundleFile = store.files.find((f) => f.absolutePath === bundlePath)!;
    const corpusFile = store.files.find((f) => f.absolutePath === corpusPath)!;
    expect(bundle).toContain(bundleFile.content);
    expect(corpus).toContain(corpusFile.content);
    expect(bundle).not.toContain(corpusFile.content);
  });
});
