import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { decideDirectMutation, decideDirectWrite } from "./direct.js";
import type { SandboxPolicy } from "./policy.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pipkin-sandbox-direct-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  const outside = join(root, "workspace-copy");
  mkdirSync(workspace);
  mkdirSync(outside);
  const canonicalWorkspace = realpathSync(workspace);
  const policy: SandboxPolicy = {
    sessionCwd: canonicalWorkspace,
    workspaceRoot: canonicalWorkspace,
    temporaryRoots: [],
    cacheRoots: [],
    writableRoots: [canonicalWorkspace],
  };
  return {
    outside: realpathSync(outside),
    policy,
    workspace: canonicalWorkspace,
  };
}

describe("Sandbox direct writes", () => {
  it("allows workspace files and missing descendants", () => {
    const { policy, workspace } = fixture();
    expect(decideDirectWrite("file.txt", policy)).toMatchObject({
      kind: "allow",
      target: join(workspace, "file.txt"),
    });
    expect(
      decideDirectWrite(join(workspace, "new", "file.txt"), policy).kind,
    ).toBe("allow");
    expect(decideDirectWrite(workspace, policy).kind).toBe("allow");
  });

  it("rejects traversal, prefix lookalikes, and symlink escapes", () => {
    const { outside, policy, workspace } = fixture();
    writeFileSync(join(outside, "file.txt"), "outside");
    symlinkSync(join(outside, "file.txt"), join(workspace, "file-link"));
    symlinkSync(outside, join(workspace, "directory-link"));
    symlinkSync(join(outside, "missing.txt"), join(workspace, "dangling-link"));
    for (const [path, target] of [
      [join(outside, "file.txt"), join(outside, "file.txt")],
      ["../workspace-copy/file.txt", join(outside, "file.txt")],
      [`${outside}\\..\\workspace\\file.txt`, undefined],
      ["file-link", join(outside, "file.txt")],
      ["directory-link/new.txt", join(outside, "new.txt")],
      ["dangling-link", join(outside, "missing.txt")],
    ]) {
      expect(decideDirectWrite(path, policy)).toMatchObject({
        kind: "deny",
        reason: "Sandbox: direct writes must stay in the workspace.",
        ...(target ? { target } : {}),
      });
    }
  });

  it("applies Pi path normalization before containment", () => {
    const { outside, policy } = fixture();
    const outsideFile = join(outside, "outside.txt");
    for (const path of [
      `@${outsideFile}`,
      pathToFileURL(outsideFile).toString(),
      "~/pipkin-sandbox-outside.txt",
    ]) {
      expect(decideDirectWrite(path, policy).kind).toBe("deny");
    }
  });

  it("uses the same containment decision for write and edit and rejects malformed paths", () => {
    const { policy, workspace } = fixture();
    for (const tool of ["write", "edit"] as const) {
      expect(
        decideDirectMutation({
          tool,
          input: { path: "inside.txt" },
          policy,
        }),
      ).toMatchObject({ kind: "allow", target: join(workspace, "inside.txt") });
    }
    for (const path of [undefined, "", "inside\0.txt"]) {
      expect(decideDirectWrite(path, policy)).toMatchObject({ kind: "deny" });
    }
    symlinkSync("loop", join(workspace, "loop"));
    expect(decideDirectWrite("loop", policy)).toEqual({
      kind: "deny",
      reason: "Sandbox: filesystem path is invalid.",
    });
  });

  it("retains the session-subdirectory base while checking the worktree root", () => {
    const { policy, workspace } = fixture();
    const child = join(workspace, "child");
    mkdirSync(child);
    const nestedPolicy = { ...policy, sessionCwd: child };
    expect(decideDirectWrite("from-child.txt", nestedPolicy)).toMatchObject({
      kind: "allow",
      target: join(child, "from-child.txt"),
    });
    expect(decideDirectWrite("../sibling.txt", nestedPolicy).kind).toBe(
      "allow",
    );
  });
});
