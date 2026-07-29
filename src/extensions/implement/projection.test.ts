import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCheckboxProjectionIntent,
  settleCheckboxProjection,
} from "./projection.js";

const temporaryDirectories = new Set<string>();

function fixture(content = "# Plan\n\n- [ ] First\n- [ ] Second\n"): {
  root: string;
  plan: string;
} {
  const root = mkdtempSync(join(tmpdir(), "pipkin-implement-projection-"));
  temporaryDirectories.add(root);
  const plan = join(root, "plan.md");
  writeFileSync(plan, content);
  return { root, plan };
}

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe(" checkbox projection", () => {
  it("atomically projects only anchored top-level checkbox markers and settles after a post-write crash", () => {
    const { root, plan } = fixture();
    const intent = createCheckboxProjectionIntent({
      id: "projection-1",
      checkoutRoot: root,
      taskIds: ["first", "second"],
      checkboxes: [
        { path: plan, lineNumber: 3, lineText: "- [ ] First" },
        { path: plan, lineNumber: 4, lineText: "- [ ] Second" },
      ],
    });

    expect(settleCheckboxProjection(root, intent)).toMatchObject({
      kind: "written",
      protectedHash: intent.expectedNewHash,
    });
    expect(settleCheckboxProjection(root, intent)).toMatchObject({
      kind: "already_written",
      protectedHash: intent.expectedNewHash,
    });
  });

  it("projects indented task checkboxes", () => {
    const { root, plan } = fixture("# Plan\n\n  - [ ] First\n  - [ ] Second\n");
    const intent = createCheckboxProjectionIntent({
      id: "projection-indented",
      checkoutRoot: root,
      taskIds: ["first", "second"],
      checkboxes: [
        { path: plan, lineNumber: 3, lineText: "  - [ ] First" },
        { path: plan, lineNumber: 4, lineText: "  - [ ] Second" },
      ],
    });

    expect(settleCheckboxProjection(root, intent)).toMatchObject({
      kind: "written",
    });
  });

  it("refuses to overwrite third-party source changes", () => {
    const { root, plan } = fixture();
    const intent = createCheckboxProjectionIntent({
      id: "projection-1",
      checkoutRoot: root,
      taskIds: ["first"],
      checkboxes: [{ path: plan, lineNumber: 3, lineText: "- [ ] First" }],
    });
    writeFileSync(plan, "# Plan\n\n- [ ] Changed\n- [ ] Second\n");

    expect(settleCheckboxProjection(root, intent)).toMatchObject({
      kind: "safety_paused",
      reason: expect.stringMatching(/neither durable intent side/),
    });
  });

  it("rejects a source path replaced by a symlink", () => {
    const { root, plan } = fixture();
    const intent = createCheckboxProjectionIntent({
      id: "projection-1",
      checkoutRoot: root,
      taskIds: ["first"],
      checkboxes: [{ path: plan, lineNumber: 3, lineText: "- [ ] First" }],
    });
    const replacement = join(root, "replacement.md");
    writeFileSync(replacement, intent.expectedOldContent);
    rmSync(plan);
    symlinkSync(replacement, plan);

    expect(settleCheckboxProjection(root, intent)).toMatchObject({
      kind: "safety_paused",
    });
  });
});
