import { mkdtempSync, mkdirSync, writeFileSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePlan } from "./plan.js";
import { buildMaterialStore } from "./material-store.js";
import {
  parseNeedsMaterialResponse,
  resolveNeedsMaterialRequests,
} from "./needs-material.js";

const makeTmpDir = () => mkdtempSync(join(tmpdir(), "pi-needs-material-"));

function makeStore(dir: string, planName = "plan.md") {
  const planPath = join(dir, planName);
  const planContent = "# Plan\n\n## Tasks\n\n- [ ] Task\n";
  writeFileSync(planPath, planContent, "utf-8");
  const plan = parsePlan(planPath, planContent);
  return buildMaterialStore({ plan, planPath, repoRoot: dir });
}

describe("parseNeedsMaterialResponse", () => {
  it("parses a valid needs_material response", () => {
    const text = JSON.stringify({
      kind: "needs_material",
      requests: [
        {
          pathHint: "docs/context.md",
          relativeTo: "repo",
          reason: "Contains the API contract.",
        },
      ],
    });
    const result = parseNeedsMaterialResponse(text);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toEqual({
      kind: "needs_material",
      requests: [
        {
          pathHint: "docs/context.md",
          relativeTo: "repo",
          reason: "Contains the API contract.",
        },
      ],
    });
  });

  it("rejects a response missing kind", () => {
    const text = JSON.stringify({
      requests: [{ pathHint: "x.md", reason: "need it" }],
    });
    const result = parseNeedsMaterialResponse(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("kind");
  });

  it("rejects a request missing pathHint", () => {
    const text = JSON.stringify({
      kind: "needs_material",
      requests: [{ reason: "need it" }],
    });
    const result = parseNeedsMaterialResponse(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("pathHint");
  });

  it("rejects a request missing reason", () => {
    const text = JSON.stringify({
      kind: "needs_material",
      requests: [{ pathHint: "x.md" }],
    });
    const result = parseNeedsMaterialResponse(text);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain("reason");
  });
});

describe("resolveNeedsMaterialRequests", () => {
  it("resolves a safe local Markdown file relative to the plan", () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);
    const materialPath = join(dir, "material.md");
    writeFileSync(materialPath, "# Material\n\nDetails.\n", "utf-8");

    const result = resolveNeedsMaterialRequests(
      [{ pathHint: "material.md", reason: "needed" }],
      store,
    );

    expect(result.errors).toHaveLength(0);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      absolutePath: materialPath,
      displayPath: "material.md",
      content: "# Material\n\nDetails.\n",
    });
    expect(result.files[0].hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("resolves a file relative to the repo root", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "docs"), { recursive: true });
    const store = makeStore(dir);
    const materialPath = join(dir, "docs", "context.md");
    writeFileSync(materialPath, "# Context\n", "utf-8");

    const result = resolveNeedsMaterialRequests(
      [{ pathHint: "docs/context.md", relativeTo: "repo", reason: "needed" }],
      store,
    );

    expect(result.errors).toHaveLength(0);
    expect(result.files[0]?.absolutePath).toBe(materialPath);
  });

  it("rejects a URL request", () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);

    const result = resolveNeedsMaterialRequests(
      [{ pathHint: "https://example.com/file.md", reason: "needed" }],
      store,
    );

    expect(result.files).toHaveLength(0);
    expect(result.errors[0]).toContain("URL");
  });

  it("rejects a non-markdown file", () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);
    const otherPath = join(dir, "file.ts");
    writeFileSync(otherPath, "// code\n", "utf-8");

    const result = resolveNeedsMaterialRequests(
      [{ pathHint: "file.ts", reason: "needed" }],
      store,
    );

    expect(result.files).toHaveLength(0);
    expect(result.errors[0]).toContain("non-markdown");
  });

  it("rejects a missing file", () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);

    const result = resolveNeedsMaterialRequests(
      [{ pathHint: "missing.md", reason: "needed" }],
      store,
    );

    expect(result.files).toHaveLength(0);
    expect(result.errors[0]).toContain("missing");
  });

  it("rejects a directory", () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);
    mkdirSync(join(dir, "docs"), { recursive: true });

    const result = resolveNeedsMaterialRequests(
      [{ pathHint: "docs", reason: "needed" }],
      store,
    );

    expect(result.files).toHaveLength(0);
    expect(result.errors[0]).toContain("directory");
    rmdirSync(join(dir, "docs"));
  });

  it("rejects an empty file", () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);
    const emptyPath = join(dir, "empty.md");
    writeFileSync(emptyPath, "   \n", "utf-8");

    const result = resolveNeedsMaterialRequests(
      [{ pathHint: "empty.md", reason: "needed" }],
      store,
    );

    expect(result.files).toHaveLength(0);
    expect(result.errors[0]).toContain("empty");
  });

  it("rejects a path escape outside allowed roots", () => {
    const dir = makeTmpDir();
    const planDir = join(dir, "plans");
    mkdirSync(planDir, { recursive: true });
    const store = makeStore(planDir, "plan.md");
    const outsidePath = join(dir, "outside.md");
    writeFileSync(outsidePath, "# Outside\n", "utf-8");

    const result = resolveNeedsMaterialRequests(
      [{ pathHint: "../outside.md", reason: "needed" }],
      store,
    );

    expect(result.files).toHaveLength(0);
    expect(result.errors[0]).toContain("escapes allowed roots");
  });

  it("rejects an empty path hint", () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);

    const result = resolveNeedsMaterialRequests(
      [{ pathHint: "", reason: "needed" }],
      store,
    );

    expect(result.files).toHaveLength(0);
    expect(result.errors[0]).toContain("empty");
  });

  it("collects multiple errors without short-circuiting", () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);

    const result = resolveNeedsMaterialRequests(
      [
        { pathHint: "https://example.com/x.md", reason: "url" },
        { pathHint: "file.ts", reason: "not markdown" },
      ],
      store,
    );

    expect(result.files).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
  });

  it("rejects an empty request array", () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);

    const result = resolveNeedsMaterialRequests([], store);

    expect(result.files).toHaveLength(0);
    expect(result.errors[0]).toContain("No material requests");
  });

  it("skips files already present in the material store to preserve frozen hashes", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "docs"), { recursive: true });
    const materialPath = join(dir, "docs", "context.md");
    writeFileSync(materialPath, "# Context\n", "utf-8");

    const planPath = join(dir, "plan.md");
    const planContent = `# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: \`docs/context.md\`\n`;
    writeFileSync(planPath, planContent, "utf-8");
    const plan = parsePlan(planPath, planContent);
    const store = buildMaterialStore({ plan, planPath, repoRoot: dir });

    const result = resolveNeedsMaterialRequests(
      [{ pathHint: "docs/context.md", reason: "already present" }],
      store,
    );

    expect(result.files).toHaveLength(0);
    expect(result.errors[0]).toContain("already present");
  });

  it("accepts new files while skipping files already present in the store", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "docs"), { recursive: true });
    const existingPath = join(dir, "docs", "context.md");
    const newPath = join(dir, "new.md");
    writeFileSync(existingPath, "# Context\n", "utf-8");
    writeFileSync(newPath, "# New\n", "utf-8");

    const planPath = join(dir, "plan.md");
    const planContent = `# Plan\n\n## Tasks\n\n- [ ] Task\n  - Plan: \`docs/context.md\`\n`;
    writeFileSync(planPath, planContent, "utf-8");
    const plan = parsePlan(planPath, planContent);
    const store = buildMaterialStore({ plan, planPath, repoRoot: dir });

    const result = resolveNeedsMaterialRequests(
      [
        { pathHint: "docs/context.md", reason: "already present" },
        { pathHint: "new.md", reason: "needed" },
      ],
      store,
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.absolutePath).toBe(newPath);
    expect(result.errors).toHaveLength(0);
  });
});
