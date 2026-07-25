import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMaterialStore } from "./material-store.js";
import { parsePlan } from "./plan.js";

const temporaryDirectories = new Set<string>();

function fixture(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-implement-material-"));
  temporaryDirectories.add(path);
  return path;
}

function storeFor(planPath: string, repoRoot?: string) {
  const content = requirePlanContent(planPath);
  return buildMaterialStore({
    plan: parsePlan(planPath, content),
    planPath,
    ...(repoRoot ? { repoRoot } : {}),
  });
}

function requirePlanContent(path: string): string {
  return readFileSync(path, "utf-8");
}

afterEach(() => {
  for (const path of temporaryDirectories) {
    rmSync(path, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("buildMaterialStore", () => {
  it("recursively ingests ordinary local Markdown links and deduplicates cycles", () => {
    const root = temporaryDirectory();
    const planPath = join(root, "plan.md");
    fixture(planPath, "# Plan\n\n- [ ] Task\n\n[a](docs/a.md)\n");
    fixture(join(root, "docs", "a.md"), "[b](b.md)\n");
    fixture(join(root, "docs", "b.md"), "[plan](../plan.md)\n");

    const store = storeFor(planPath, root);

    expect(store.validationErrors).toEqual([]);
    expect(store.files.map((file) => file.absolutePath).sort()).toEqual(
      [planPath, join(root, "docs", "a.md"), join(root, "docs", "b.md")].sort(),
    );
    expect(store.storeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ignores image, URL, and non-Markdown links", () => {
    const root = temporaryDirectory();
    const planPath = join(root, "plan.md");
    fixture(
      planPath,
      "# Plan\n\n- [ ] Task\n\n![image](image.png) [site](https://example.com/a.md) [text](notes.txt)\n",
    );

    const store = storeFor(planPath, root);

    expect(store.files).toHaveLength(1);
    expect(store.validationErrors).toEqual([]);
  });

  it("blocks missing and escaping Markdown links from entering the corpus", () => {
    const root = temporaryDirectory();
    const planPath = join(root, "plans", "plan.md");
    fixture(
      planPath,
      "# Plan\n\n- [ ] Task\n\n[missing](missing.md) [outside](../outside.md)\n",
    );
    fixture(join(root, "outside.md"), "# Outside\n");

    const store = storeFor(planPath);

    expect(store.files.map((file) => file.absolutePath)).toEqual([planPath]);
    expect(store.validationErrors).toHaveLength(2);
    expect(store.validationErrors.join("\n")).toContain("missing");
    expect(store.validationErrors.join("\n")).toContain("escapes allowed root");
  });

  it("rejects symlink escapes and resolves repository-root-relative links", () => {
    const root = temporaryDirectory();
    const planPath = join(root, "plans", "plan.md");
    const shared = join(root, "shared.md");
    const outside = "/dev/null";
    fixture(
      planPath,
      "# Plan\n\n- [ ] Task\n\n[shared](shared.md) [escape](escape.md)\n",
    );
    fixture(shared, "# Shared\n");
    symlinkSync(outside, join(root, "plans", "escape.md"));

    const store = storeFor(planPath, root);

    expect(store.files.map((file) => file.absolutePath)).toContain(shared);
    expect(store.files.map((file) => file.absolutePath)).not.toContain(
      join(root, "plans", "escape.md"),
    );
    expect(store.validationErrors.join("\n")).toContain("escapes allowed root");
  });
});
