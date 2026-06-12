import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestPlanCorpus,
  formatCorpusMaterial,
  MAX_CORPUS_FILES,
  MAX_CORPUS_CHARS,
} from "./corpus.js";

const makeTmpDir = () => mkdtempSync(join(tmpdir(), "pi-corpus-test-"));

describe("ingestPlanCorpus", () => {
  it("ingests a single-file plan", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    writeFileSync(entryPath, "# Plan\n\n- [ ] Do it\n", "utf-8");

    const corpus = ingestPlanCorpus(entryPath);

    expect(corpus.entryPath).toBe(entryPath);
    expect(corpus.files).toHaveLength(1);
    expect(corpus.files[0].absolutePath).toBe(entryPath);
    expect(corpus.validationErrors).toHaveLength(0);
    expect(corpus.corpusHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ingests an index file with local markdown links", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      entryPath,
      "# Plan\n\nSee [sub plan](sub.md) for details.\n\n- [ ] Do it\n",
      "utf-8",
    );
    writeFileSync(subPath, "# Sub\n\nDetails.\n", "utf-8");

    const corpus = ingestPlanCorpus(entryPath);

    expect(corpus.files).toHaveLength(2);
    expect(corpus.files[1].absolutePath).toBe(subPath);
    expect(corpus.validationErrors).toHaveLength(0);
  });

  it("auto-discovers sibling task files when linking into tasks/", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    const tasksDir = join(dir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const taskA = join(tasksDir, "a.md");
    const taskB = join(tasksDir, "b.md");
    const taskC = join(tasksDir, "c.md");
    writeFileSync(
      entryPath,
      "# Plan\n\nSee [tasks](tasks/a.md) for details.\n\n- [ ] Do it\n",
      "utf-8",
    );
    writeFileSync(taskA, "# A\n", "utf-8");
    writeFileSync(taskB, "# B\n", "utf-8");
    writeFileSync(taskC, "# C\n", "utf-8");

    const corpus = ingestPlanCorpus(entryPath);

    const paths = corpus.files.map((f) => f.absolutePath);
    expect(paths).toContain(entryPath);
    expect(paths).toContain(taskA);
    expect(paths).toContain(taskB);
    expect(paths).toContain(taskC);
    expect(corpus.files).toHaveLength(4);
    expect(corpus.validationErrors).toHaveLength(0);
  });

  it("reports a validation error for URL links", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    writeFileSync(
      entryPath,
      "# Plan\n\nSee [docs](https://example.com/doc.md).\n\n- [ ] Do it\n",
      "utf-8",
    );

    const corpus = ingestPlanCorpus(entryPath);

    expect(corpus.validationErrors).toHaveLength(1);
    expect(corpus.validationErrors[0]).toContain("URL");
    expect(corpus.validationErrors[0]).toContain("https://example.com/doc.md");
  });

  it("reports a validation error for missing files", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    writeFileSync(
      entryPath,
      "# Plan\n\nSee [missing](missing.md).\n\n- [ ] Do it\n",
      "utf-8",
    );

    const corpus = ingestPlanCorpus(entryPath);

    expect(corpus.validationErrors).toHaveLength(1);
    expect(corpus.validationErrors[0]).toContain("missing");
  });

  it("reports a validation error for directory targets", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    const subDir = join(dir, "tasks");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      entryPath,
      "# Plan\n\nSee [dir](tasks).\n\n- [ ] Do it\n",
      "utf-8",
    );

    const corpus = ingestPlanCorpus(entryPath);

    expect(corpus.validationErrors).toHaveLength(1);
    expect(corpus.validationErrors[0]).toContain("directory");
  });

  it("reports a validation error for non-markdown files", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.txt");
    writeFileSync(
      entryPath,
      "# Plan\n\nSee [sub](sub.txt).\n\n- [ ] Do it\n",
      "utf-8",
    );
    writeFileSync(subPath, "not markdown", "utf-8");

    const corpus = ingestPlanCorpus(entryPath);

    expect(corpus.validationErrors).toHaveLength(1);
    expect(corpus.validationErrors[0]).toContain("non-markdown");
  });

  it("reports a validation error for empty files", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      entryPath,
      "# Plan\n\nSee [sub](sub.md).\n\n- [ ] Do it\n",
      "utf-8",
    );
    writeFileSync(subPath, "   \n", "utf-8");

    const corpus = ingestPlanCorpus(entryPath);

    expect(corpus.validationErrors).toHaveLength(1);
    expect(corpus.validationErrors[0]).toContain("empty");
  });

  it("does not recursively slurp arbitrary directories", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    const subDir = join(dir, "other");
    mkdirSync(subDir, { recursive: true });
    const subPath = join(subDir, "sub.md");
    writeFileSync(
      entryPath,
      "# Plan\n\nSee [sub](other/sub.md).\n\n- [ ] Do it\n",
      "utf-8",
    );
    writeFileSync(subPath, "# Sub\n", "utf-8");

    const corpus = ingestPlanCorpus(entryPath);

    expect(corpus.files).toHaveLength(2);
    expect(corpus.files.map((f) => f.absolutePath)).toContain(subPath);
    expect(corpus.validationErrors).toHaveLength(0);
  });

  it("reports an error when corpus exceeds max file count", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    let content = "# Plan\n\n";
    for (let i = 0; i < MAX_CORPUS_FILES + 1; i++) {
      const subPath = join(dir, `sub${i}.md`);
      writeFileSync(subPath, `# Sub ${i}\n`, "utf-8");
      content += `See [sub${i}](sub${i}.md).\n`;
    }
    content += "\n- [ ] Do it\n";
    writeFileSync(entryPath, content, "utf-8");

    const corpus = ingestPlanCorpus(entryPath);

    expect(corpus.validationErrors.length).toBeGreaterThan(0);
    expect(corpus.validationErrors.some((e) => e.includes("file count"))).toBe(
      true,
    );
  });

  it("reports an error when corpus exceeds max character count", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      entryPath,
      "# Plan\n\nSee [sub](sub.md).\n\n- [ ] Do it\n",
      "utf-8",
    );
    writeFileSync(subPath, "x".repeat(MAX_CORPUS_CHARS + 1), "utf-8");

    const corpus = ingestPlanCorpus(entryPath);

    expect(corpus.validationErrors.length).toBeGreaterThan(0);
    expect(corpus.validationErrors.some((e) => e.includes("size"))).toBe(true);
  });

  it("deduplicates duplicate links", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      entryPath,
      "# Plan\n\nSee [one](sub.md) and [two](sub.md).\n\n- [ ] Do it\n",
      "utf-8",
    );
    writeFileSync(subPath, "# Sub\n", "utf-8");

    const corpus = ingestPlanCorpus(entryPath);

    expect(corpus.files).toHaveLength(2);
    expect(corpus.validationErrors).toHaveLength(0);
  });

  it("includes entry file hash in the corpus hash", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    writeFileSync(entryPath, "# Plan\n\n- [ ] Do it\n", "utf-8");

    const corpus1 = ingestPlanCorpus(entryPath);
    writeFileSync(entryPath, "# Plan\n\n- [ ] Do it changed\n", "utf-8");
    const corpus2 = ingestPlanCorpus(entryPath);

    expect(corpus1.corpusHash).not.toBe(corpus2.corpusHash);
  });

  it("does not include image links", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    writeFileSync(
      entryPath,
      "# Plan\n\n![image](image.png)\n\n- [ ] Do it\n",
      "utf-8",
    );

    const corpus = ingestPlanCorpus(entryPath);

    expect(corpus.files).toHaveLength(1);
    expect(corpus.validationErrors).toHaveLength(0);
  });

  it("discovers tasks in tasks/ subdirectories of nested paths", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    const tasksDir = join(dir, "features", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const taskA = join(tasksDir, "a.md");
    const taskB = join(tasksDir, "b.md");
    writeFileSync(
      entryPath,
      "# Plan\n\nSee [tasks](features/tasks/a.md).\n\n- [ ] Do it\n",
      "utf-8",
    );
    writeFileSync(taskA, "# A\n", "utf-8");
    writeFileSync(taskB, "# B\n", "utf-8");

    const corpus = ingestPlanCorpus(entryPath);

    const paths = corpus.files.map((f) => f.absolutePath);
    expect(paths).toContain(entryPath);
    expect(paths).toContain(taskA);
    expect(paths).toContain(taskB);
    expect(corpus.files).toHaveLength(3);
    expect(corpus.validationErrors).toHaveLength(0);
  });
});

describe("formatCorpusMaterial", () => {
  it("returns empty string for single-file corpus", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    writeFileSync(entryPath, "# Plan\n", "utf-8");

    const corpus = ingestPlanCorpus(entryPath);
    const formatted = formatCorpusMaterial(corpus);

    expect(formatted).toBe("");
  });

  it("formats supplementary files excluding entry", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    const subPath = join(dir, "sub.md");
    writeFileSync(
      entryPath,
      "# Plan\n\nSee [sub](sub.md).\n\n- [ ] Do it\n",
      "utf-8",
    );
    writeFileSync(subPath, "# Sub\n\nDetails.\n", "utf-8");

    const corpus = ingestPlanCorpus(entryPath);
    const formatted = formatCorpusMaterial(corpus);

    expect(formatted).toContain("### sub.md");
    expect(formatted).toContain("# Sub");
    expect(formatted).not.toContain("# Plan");
  });

  it("formats multiple supplementary files", () => {
    const dir = makeTmpDir();
    const entryPath = join(dir, "plan.md");
    const subA = join(dir, "a.md");
    const subB = join(dir, "b.md");
    writeFileSync(
      entryPath,
      "# Plan\n\nSee [a](a.md) and [b](b.md).\n\n- [ ] Do it\n",
      "utf-8",
    );
    writeFileSync(subA, "# A\n", "utf-8");
    writeFileSync(subB, "# B\n", "utf-8");

    const corpus = ingestPlanCorpus(entryPath);
    const formatted = formatCorpusMaterial(corpus);

    expect(formatted).toContain("### a.md");
    expect(formatted).toContain("### b.md");
  });
});
