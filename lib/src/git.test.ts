import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGitInfoExclude } from "./git.js";

const roots: string[] = [];

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-git-exclude-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  return root;
}

afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

describe("ensureGitInfoExclude", () => {
  it("adds one exact pattern through a linked worktree's common git directory", async () => {
    const root = repo();
    const worktree = mkdtempSync(join(tmpdir(), "pi-git-exclude-worktree-"));
    roots.push(worktree);
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], {
      cwd: root,
    });
    execFileSync("git", ["worktree", "add", "-q", worktree], { cwd: root });

    await ensureGitInfoExclude(worktree, "/.pi/papercuts.json");
    await ensureGitInfoExclude(worktree, "/.pi/papercuts.json");

    expect(
      readFileSync(join(root, ".git", "info", "exclude"), "utf-8")
        .split("\n")
        .filter((line) => line === "/.pi/papercuts.json"),
    ).toHaveLength(1);
    execFileSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: root,
    });
  });
});
