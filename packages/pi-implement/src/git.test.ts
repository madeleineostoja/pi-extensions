import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExecGitClient, isCleanStatus } from "./git.js";

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-implement-git-"));
  git(cwd, "init");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, "tracked.ts"), "export const value = 1;\n");
  git(cwd, "add", "tracked.ts");
  git(cwd, "commit", "-m", "chore: init");
  return cwd;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("git helpers", () => {
  it("parses clean status", () => {
    expect(isCleanStatus("")).toBe(true);
    expect(isCleanStatus(" M file.ts\n")).toBe(false);
  });

  it("stages untracked files for review", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "new.ts"), "export const added = true;\n");
    const client = new ExecGitClient(cwd);

    await client.stageAllExcept([]);

    expect(await client.stagedNameStatus()).toContain("A\tnew.ts");
    expect(await client.stagedDiff()).toContain("export const added = true;");
  });

  it("stages repo-relative paths from a nested client cwd", async () => {
    const cwd = repo();
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "nested.ts"),
      "export const nested = true;\n",
    );
    const client = new ExecGitClient(join(cwd, "src"));

    await client.stagePaths(["src/nested.ts"]);

    expect(await client.stagedNameStatus()).toBe("A\tsrc/nested.ts\n");
  });

  it("excludes plan artifacts without force-adding ignored files", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, ".gitignore"), "plan.md\nignored.log\n");
    git(cwd, "add", ".gitignore");
    git(cwd, "commit", "-m", "chore: ignore files");
    writeFileSync(join(cwd, "plan.md"), "# Plan\n");
    writeFileSync(join(cwd, "ignored.log"), "ignored\n");
    writeFileSync(join(cwd, "new.ts"), "export const added = true;\n");
    const client = new ExecGitClient(cwd);

    await client.stageAllExcept([join(cwd, "plan.md")]);

    expect(await client.stagedNameStatus()).toBe("A\tnew.ts\n");
  });

  it("treats worktree as clean except known plan artifacts", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "plan.md"), "# Plan\n");
    writeFileSync(join(cwd, "tracked.ts"), "export const value = 2;\n");
    const client = new ExecGitClient(cwd);

    expect(await client.isCleanExcept([join(cwd, "plan.md")])).toBe(false);
    git(cwd, "checkout", "--", "tracked.ts");
    expect(await client.isCleanExcept([join(cwd, "plan.md")])).toBe(true);
  });

  it("normalizes accidental forced ignored staging", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, ".gitignore"), "ignored.log\n");
    git(cwd, "add", ".gitignore");
    git(cwd, "commit", "-m", "chore: ignore logs");
    writeFileSync(join(cwd, "ignored.log"), "ignored\n");
    writeFileSync(join(cwd, "new.ts"), "export const added = true;\n");
    git(cwd, "add", "-f", "ignored.log");
    const client = new ExecGitClient(cwd);

    await client.stageAllExcept([]);

    expect(await client.stagedNameStatus()).toBe("A\tnew.ts\n");
  });

  it("restores reviewer worktree edits from the staged index", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "tracked.ts"), "export const value = 2;\n");
    const client = new ExecGitClient(cwd);
    await client.stageAllExcept([]);
    const before = await client.worktreeFingerprintExcept([]);
    writeFileSync(join(cwd, "tracked.ts"), "export const value = 3;\n");
    writeFileSync(join(cwd, "reviewer.tmp"), "oops\n");

    await client.restoreWorktreeFromIndexExcept([]);

    expect(await client.worktreeFingerprintExcept([])).toBe(before);
    expect(git(cwd, "status", "--porcelain")).toBe("M  tracked.ts\n");
  });

  it("restores the staged candidate patch after index mutation", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "tracked.ts"), "export const value = 2;\n");
    const client = new ExecGitClient(cwd);
    await client.stageAllExcept([]);
    const patch = await client.stagedDiff();
    const before = await client.stagedFingerprint();
    git(cwd, "reset", "--hard", "HEAD");

    await client.restoreStagedPatch(patch, []);

    expect(await client.stagedFingerprint()).toBe(before);
    expect(git(cwd, "status", "--porcelain")).toBe("M  tracked.ts\n");
  });

  it("creates a task branch at the specified base SHA", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();

    await client.createTaskBranch("pi-implement/r1/t001-task", baseSha);

    const branches = git(cwd, "branch", "--list");
    expect(branches).toContain("pi-implement/r1/t001-task");
  });

  it("adds and removes a worktree", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = join(
      cwd,
      ".pi",
      "implement",
      "worktrees",
      "r1",
      "t001-wt-test",
    );
    const branchName = "pi-implement/r1/t001-wt-test";

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    const wtList = git(cwd, "worktree", "list", "--porcelain");
    expect(wtList).toContain(worktreePath);

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);

    const wtListAfter = git(cwd, "worktree", "list", "--porcelain");
    expect(wtListAfter).not.toContain(worktreePath);
    const branchesAfter = git(cwd, "branch", "--list");
    expect(branchesAfter).not.toContain(branchName);
  });

  it("idempotently registers an info/exclude pattern and hides in-repo worktrees from status", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = join(
      cwd,
      ".pi",
      "implement",
      "worktrees",
      "r1",
      "t001-wt-test",
    );
    const branchName = "pi-implement/r1/t001-wt-test";

    await client.ensureInfoExclude("/.pi/implement/");
    const excludeContent = readFileSync(
      join(cwd, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(excludeContent).toContain("/.pi/implement/");

    // Second call must not duplicate the line
    await client.ensureInfoExclude("/.pi/implement/");
    const excludeContentAfter = readFileSync(
      join(cwd, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(
      excludeContentAfter.split("\n").filter((l) => l === "/.pi/implement/"),
    ).toHaveLength(1);

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    expect(await client.isClean()).toBe(true);

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);
  });

  it("forWorktree returns a GitClient rooted at the worktree", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = realpathSync(
      mkdtempSync(join(tmpdir(), "pi-implement-wt2-")),
    );
    const branchName = "pi-implement/r1/t001-for-wt";

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    const wtClient = client.forWorktree(worktreePath);
    const wtRoot = await wtClient.root();
    expect(wtRoot).toBe(worktreePath);

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);
  });

  it("uses the git admin dir as a per-checkout identity", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = realpathSync(
      mkdtempSync(join(tmpdir(), "pi-implement-wt-identity-")),
    );
    const branchName = "pi-implement/r1/t001-identity";

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    const mainIdentity = await client.checkoutIdentity();
    const wtIdentity = await client
      .forWorktree(worktreePath)
      .checkoutIdentity();

    expect(mainIdentity).not.toBe(wtIdentity);
    expect(wtIdentity).toContain(join(".git", "worktrees"));

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);
  });

  it("stages and commits in a worktree without changing main HEAD", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = realpathSync(
      mkdtempSync(join(tmpdir(), "pi-implement-wt3-")),
    );
    const branchName = "pi-implement/r1/t001-commit-test";

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    const wtClient = client.forWorktree(worktreePath);
    writeFileSync(join(worktreePath, "new.ts"), "export const added = true;\n");
    await wtClient.stageAllExcept([]);
    expect(await wtClient.hasStagedChanges()).toBe(true);
    const commitResult = await wtClient.commit("feat: add new.ts");
    expect(commitResult.exitCode).toBe(0);

    // Main HEAD should be unchanged
    expect(await client.head()).toBe(baseSha);
    // Worktree HEAD should have advanced
    expect(await wtClient.head()).not.toBe(baseSha);

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);
  });

  it("reads staged diff, diff stat, and name-status from a worktree", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = realpathSync(
      mkdtempSync(join(tmpdir(), "pi-implement-wt4-")),
    );
    const branchName = "pi-implement/r1/t001-diff-test";

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    const wtClient = client.forWorktree(worktreePath);
    writeFileSync(join(worktreePath, "diff.ts"), "export const x = 42;\n");
    await wtClient.stageAllExcept([]);

    expect(await wtClient.stagedDiff()).toContain("diff.ts");
    expect(await wtClient.stagedDiffStat()).toContain("diff.ts");
    expect(await wtClient.stagedNameStatus()).toContain("diff.ts");

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);
  });

  it("excludes main-checkout plan artifacts when staging in a worktree", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "plan.md"), "# Plan\n");
    git(cwd, "add", "plan.md");
    git(cwd, "commit", "-m", "chore: add plan");
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = realpathSync(
      mkdtempSync(join(tmpdir(), "pi-implement-wt5-")),
    );
    const branchName = "pi-implement/r1/t001-plan-exclude";

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    const wtClient = client.forWorktree(worktreePath);
    writeFileSync(join(worktreePath, "plan.md"), "# Mutated Plan\n");
    writeFileSync(
      join(worktreePath, "worker.ts"),
      "export const worker = true;\n",
    );
    await wtClient.stageAllExcept([join(cwd, "plan.md")]);

    expect(await wtClient.stagedNameStatus()).toBe("A\tworker.ts\n");

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);
  });

  it("returns the diff between two commits", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();

    writeFileSync(join(cwd, "feature.ts"), "export const feat = true;\n");
    git(cwd, "add", "feature.ts");
    git(cwd, "commit", "-m", "feat: add feature");

    const headSha = await client.head();
    const diff = await client.diffRange(baseSha, headSha);

    expect(diff).toContain("feature.ts");
    expect(diff).toContain("export const feat = true;");
  });

  it("rewords the current commit message without changing parent", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);

    writeFileSync(join(cwd, "feature.ts"), "export const feat = true;\n");
    git(cwd, "add", "feature.ts");
    git(cwd, "commit", "-m", "feat: add feature");

    const parentSha = git(cwd, "rev-parse", "HEAD^").trim();
    const beforeHead = await client.head();

    const result = await client.reword("feat: add feature (reworded)");
    expect(result.exitCode).toBe(0);

    const afterHead = await client.head();
    expect(afterHead).not.toBe(beforeHead);

    const message = git(cwd, "log", "-1", "--format=%B").trim();
    expect(message).toBe("feat: add feature (reworded)");

    const afterParentSha = git(cwd, "rev-parse", "HEAD^").trim();
    expect(afterParentSha).toBe(parentSha);
  });
});
