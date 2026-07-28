import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinPreview, DETAIL_LIMIT, unknownBackendPreview } from "./preview";
import { resolveChoice } from "./handler";

describe("edit/write approval", () => {
  it("renders a bounded built-in write and explicit ambiguous backend input", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pipkin-edit-"));
    writeFileSync(join(cwd, "file.ts"), "before");
    expect(
      builtinPreview("write", { path: "file.ts", content: "after" }, cwd)
        .detail,
    ).toContain("-before\n+after");
    expect(
      unknownBackendPreview({ value: "x".repeat(DETAIL_LIMIT * 2) }),
    ).toContain("Custom or unknown backend; exact local preview unavailable.");
  });

  it("uses replacement blocks when an edit cannot be projected exactly", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pipkin-edit-"));
    writeFileSync(join(cwd, "file.ts"), "repeat repeat");
    const detail = builtinPreview(
      "edit",
      { path: "file.ts", edits: [{ oldText: "repeat", newText: "next" }] },
      cwd,
    ).detail;
    expect(detail).toContain("Exact patch unavailable");
    expect(detail).toContain("replacement 1");
  });

  it("keeps accept-for-session local to its extension instance", () => {
    expect(
      resolveChoice({ choice: "Accept for this session", message: "" }),
    ).toEqual({ block: false, disable: true });
    expect(resolveChoice({ choice: "Accept", message: "" })).toEqual({
      block: false,
    });
  });
});
