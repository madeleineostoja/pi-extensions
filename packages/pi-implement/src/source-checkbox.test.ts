import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tryMarkSourceCheckboxDone,
  tryMarkSourceCheckboxUndone,
} from "./source-checkbox.js";

const makeTmpDir = () =>
  mkdtempSync(join(tmpdir(), "pi-source-checkbox-test-"));

describe("tryMarkSourceCheckboxDone", () => {
  it("marks a checkbox done at the exact recorded line", () => {
    const dir = makeTmpDir();
    const path = join(dir, "plan.md");
    const content = "# Plan\n\n## Tasks\n\n- [ ] First\n- [ ] Second\n";
    writeFileSync(path, content, "utf-8");

    const result = tryMarkSourceCheckboxDone({
      path,
      lineNumber: 6,
      lineText: "- [ ] Second",
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(
      "# Plan\n\n## Tasks\n\n- [ ] First\n- [x] Second\n",
    );
  });

  it("skips with stale reason when the exact line no longer matches", () => {
    const dir = makeTmpDir();
    const path = join(dir, "plan.md");
    const content = "# Plan\n\n## Tasks\n\n- [ ] First\n- [ ] Second\n";
    writeFileSync(path, content, "utf-8");

    const result = tryMarkSourceCheckboxDone({
      path,
      lineNumber: 6,
      lineText: "- [ ] Gone",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Stale");
    }
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  it("skips with stale reason when the line number is out of range", () => {
    const dir = makeTmpDir();
    const path = join(dir, "plan.md");
    const content = "# Plan\n\n## Tasks\n\n- [ ] First\n- [ ] Second\n";
    writeFileSync(path, content, "utf-8");

    const result = tryMarkSourceCheckboxDone({
      path,
      lineNumber: 99,
      lineText: "- [ ] Missing",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Stale");
    }
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  it("skips when the line does not contain a checkbox", () => {
    const dir = makeTmpDir();
    const path = join(dir, "plan.md");
    const content = "# Plan\n\n## Tasks\n\n- [ ] First\nNot a checkbox\n";
    writeFileSync(path, content, "utf-8");

    const result = tryMarkSourceCheckboxDone({
      path,
      lineNumber: 6,
      lineText: "Not a checkbox",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("does not contain a checkbox marker");
    }
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  it("skips when the file does not exist", () => {
    const result = tryMarkSourceCheckboxDone({
      path: "/nonexistent/plan.md",
      lineNumber: 1,
      lineText: "- [ ] Task",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ENOENT");
    }
  });

  it("does not corrupt source files on failure", () => {
    const dir = makeTmpDir();
    const path = join(dir, "plan.md");
    const content = "# Plan\n\n## Tasks\n\n- [ ] First\n- [ ] Second\n";
    writeFileSync(path, content, "utf-8");

    tryMarkSourceCheckboxDone({
      path,
      lineNumber: 99,
      lineText: "- [ ] Missing",
    });

    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  it("falls back to a unique title match when recorded line metadata is stale", () => {
    const dir = makeTmpDir();
    const path = join(dir, "plan.md");
    writeFileSync(
      path,
      "# Plan\n\n## Tasks\n\n- [ ] First\n- [ ] Implement widget\n",
      "utf-8",
    );

    const result = tryMarkSourceCheckboxDone(
      { path, lineNumber: 99, lineText: "- [ ] Old widget title" },
      { title: "Implement widget", fallbackPath: path },
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("- [x] Implement widget");
  });

  it("refuses fuzzy marking when multiple checkboxes match", () => {
    const dir = makeTmpDir();
    const path = join(dir, "plan.md");
    const content =
      "# Plan\n\n## Tasks\n\n- [ ] Implement widget\n- [ ] Implement widget\n";
    writeFileSync(path, content, "utf-8");

    const result = tryMarkSourceCheckboxDone(undefined, {
      title: "Implement widget",
      fallbackPath: path,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Multiple");
    }
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  it("does not mark checkboxes outside allowed plan artifacts", () => {
    const dir = makeTmpDir();
    const planPath = join(dir, "plan.md");
    const outsidePath = join(dir, "outside.md");
    const outsideContent = "# Outside\n\n- [ ] Implement widget\n";
    writeFileSync(planPath, "# Plan\n\n## Tasks\n\n- [ ] Other\n", "utf-8");
    writeFileSync(outsidePath, outsideContent, "utf-8");

    const result = tryMarkSourceCheckboxDone(undefined, {
      title: "Implement widget",
      sourceRefs: [{ path: outsidePath, quote: "Implement widget" }],
      allowedPaths: [planPath],
    });

    expect(result.ok).toBe(false);
    expect(readFileSync(outsidePath, "utf-8")).toBe(outsideContent);
  });
});

describe("tryMarkSourceCheckboxUndone", () => {
  it("marks a checkbox undone at the exact recorded line", () => {
    const dir = makeTmpDir();
    const path = join(dir, "plan.md");
    const content = "# Plan\n\n## Tasks\n\n- [x] First\n- [x] Second\n";
    writeFileSync(path, content, "utf-8");

    const result = tryMarkSourceCheckboxUndone({
      path,
      lineNumber: 6,
      lineText: "- [x] Second",
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(
      "# Plan\n\n## Tasks\n\n- [x] First\n- [ ] Second\n",
    );
  });

  it("undoes a checkbox using the unchecked lineText after it was marked done", () => {
    const dir = makeTmpDir();
    const path = join(dir, "plan.md");
    const content = "# Plan\n\n## Tasks\n\n- [ ] First\n- [ ] Second\n";
    writeFileSync(path, content, "utf-8");

    const doneResult = tryMarkSourceCheckboxDone({
      path,
      lineNumber: 6,
      lineText: "- [ ] Second",
    });
    expect(doneResult.ok).toBe(true);

    const undoResult = tryMarkSourceCheckboxUndone({
      path,
      lineNumber: 6,
      lineText: "- [ ] Second",
    });
    expect(undoResult.ok).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(content);
  });
});
