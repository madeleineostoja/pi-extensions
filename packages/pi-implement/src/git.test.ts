import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

  it("ignores .pi/implement files in isCleanExcept", async () => {
    const cwd = repo();
    const runDir = join(cwd, ".pi", "implement", "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), "{}");
    const client = new ExecGitClient(cwd);

    expect(await client.isCleanExcept([])).toBe(true);
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

  it("does not stage .pi/implement files", async () => {
    const cwd = repo();
    const runDir = join(cwd, ".pi", "implement", "runs", "r1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), "{}");
    writeFileSync(join(cwd, "new.ts"), "export const added = true;\n");
    const client = new ExecGitClient(cwd);

    await client.stageAllExcept([]);

    expect(await client.stagedNameStatus()).toBe("A\tnew.ts\n");
  });
});
