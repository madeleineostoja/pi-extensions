import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChoice } from "./handler";
import { builtinPreview, DETAIL_LIMIT, unknownBackendPreview } from "./preview";
import { parseReadonlyArgs } from "./utils";

describe("edit/write approval", () => {
  it("renders bounded unified patches for existing and new multiline writes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pipkin-edit-"));
    writeFileSync(join(cwd, "file.ts"), "before\nsecond\n");
    const existing = builtinPreview(
      "write",
      { path: "file.ts", content: "after\nsecond\nthird\n" },
      cwd,
    ).detail;
    const created = builtinPreview(
      "write",
      { path: "new.ts", content: "first\nsecond\n" },
      cwd,
    ).detail;
    expect(existing).toMatch(/@@/);
    expect(existing).toContain("-before");
    expect(created).toMatch(/@@/);
    expect(created).toContain("+first");
  });

  it("resolves the same local paths as Pi built-ins", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pipkin-edit-"));
    writeFileSync(join(cwd, "file.ts"), "before\n");
    writeFileSync(join(cwd, "@file.ts"), "other\n");

    const detail = builtinPreview(
      "write",
      { path: "@file.ts", content: "after\n" },
      cwd,
    ).detail;

    expect(detail).toContain("-before");
    expect(detail).not.toContain("-other");
  });

  it("does not claim an exact patch for unreadable or nonprojectable edits", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pipkin-edit-"));
    writeFileSync(join(cwd, "file.ts"), "one two one");
    expect(
      builtinPreview(
        "edit",
        { path: "file.ts", edits: [{ oldText: "one", newText: "next" }] },
        cwd,
      ).detail,
    ).toContain("Exact patch unavailable");
    mkdirSync(join(cwd, "unreadable"));
    expect(
      builtinPreview("write", { path: "unreadable", content: "after" }, cwd)
        .detail,
    ).toContain("could not be read");
  });

  it("matches Pi edit projections after BOM and line-ending normalization", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pipkin-edit-"));
    writeFileSync(join(cwd, "file.ts"), "\uFEFFfirst\r\nsecond\r\n");

    const detail = builtinPreview(
      "edit",
      {
        path: "file.ts",
        edits: [{ oldText: "first\nsecond", newText: "changed\nsecond" }],
      },
      cwd,
    ).detail;

    expect(detail).toMatch(/@@/);
    expect(detail).toContain("-first");
    expect(detail).toContain("+changed");
  });

  it("projects non-overlapping multi-edits against the same original content", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pipkin-edit-"));
    writeFileSync(join(cwd, "file.ts"), "alpha beta gamma");
    const detail = builtinPreview(
      "edit",
      {
        path: "file.ts",
        edits: [
          { oldText: "alpha", newText: "first" },
          { oldText: "gamma", newText: "last" },
        ],
      },
      cwd,
    ).detail;
    expect(detail).toContain("-alpha beta gamma");
    expect(detail).toContain("+first beta last");
  });

  it("keeps unknown backend details bounded and command semantics stable", () => {
    expect(
      unknownBackendPreview({ value: "x".repeat(DETAIL_LIMIT * 2) }),
    ).toContain("Custom or unknown backend");
    expect(parseReadonlyArgs("on")).toEqual({ kind: "set", value: true });
    expect(parseReadonlyArgs("off")).toEqual({ kind: "set", value: false });
    expect(
      resolveChoice({ choice: "Accept for this session", message: "" }),
    ).toEqual({ block: false, disable: true });
  });
});
