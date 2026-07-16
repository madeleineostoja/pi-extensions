import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureRestoreSnapshot,
  checkpointCandidate,
  persistDiscardedBundle,
  restoreAndVerify,
  snapshotChanged,
} from "./candidate.js";
import { ExecGitClient } from "./git.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-implement-candidate-"));
  git(cwd, "init");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, "tracked.bin"), Buffer.from([0, 1, 2]));
  git(cwd, "add", "tracked.bin");
  git(cwd, "commit", "-m", "chore: init");
  return cwd;
}

describe("candidate recovery", () => {
  it("amends one checkpoint and detects a no-op tree", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const base = await client.head();
    writeFileSync(join(cwd, "first.ts"), "export const first = true;\n");
    await client.stageAllExcept([]);
    const first = await checkpointCandidate(client, {
      sourceBaseSha: base,
      candidateBaseSha: base,
      branchName: "task",
      discardedBundles: [],
    });
    expect(first.changed).toBe(true);
    const unchanged = await checkpointCandidate(client, first.candidate);
    expect(unchanged.changed).toBe(false);

    writeFileSync(join(cwd, "second.ts"), "export const second = true;\n");
    await client.stageAllExcept([]);
    const second = await checkpointCandidate(client, first.candidate);
    expect(second.changed).toBe(true);
    expect(git(cwd, "rev-list", "--count", `${base}..HEAD`).trim()).toBe("1");
  });

  it("captures binary, staged, unstaged, deleted, and untracked discarded edits", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    writeFileSync(join(cwd, "staged.ts"), "export const staged = true;\n");
    await client.stageAllExcept([]);
    writeFileSync(join(cwd, "tracked.bin"), Buffer.from([3, 4, 5]));
    writeFileSync(join(cwd, "untracked.txt"), "untrusted\n");
    const destination = join(cwd, "bundle");

    await persistDiscardedBundle({
      git: client,
      destination,
      protectedPaths: [],
    });

    expect(readFileSync(join(destination, "staged.patch"), "utf-8")).toContain(
      "staged.ts",
    );
    expect(readFileSync(join(destination, "working.patch"), "utf-8")).toContain(
      "GIT binary patch",
    );
    expect(
      JSON.parse(readFileSync(join(destination, "manifest.json"), "utf-8"))
        .untracked,
    ).toEqual([expect.objectContaining({ path: "untracked.txt" })]);
  });

  it("restores and proves head, index, worktree, untracked, operation, and protected artifacts", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const protectedPath = join(cwd, "plan.md");
    writeFileSync(protectedPath, "original\n");
    const snapshot = await captureRestoreSnapshot(client, [protectedPath]);
    writeFileSync(join(cwd, "tracked.bin"), Buffer.from([6, 7]));
    writeFileSync(join(cwd, "reviewer.tmp"), "dirty\n");
    writeFileSync(protectedPath, "mutated\n");

    await restoreAndVerify(client, snapshot, [protectedPath]);

    expect(readFileSync(protectedPath, "utf-8")).toBe("original\n");
    expect(await client.nonignoredUntracked()).toEqual(["plan.md"]);
    expect(await client.activeOperation()).toBeUndefined();
  });

  it("restores protected artifacts without following a replacement symlink", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const protectedPath = join(cwd, "plan.md");
    const outsidePath = join(cwd, "outside.txt");
    writeFileSync(protectedPath, "original\n");
    writeFileSync(outsidePath, "outside\n");
    const snapshot = await captureRestoreSnapshot(client, [protectedPath]);
    execFileSync("rm", [protectedPath]);
    symlinkSync(outsidePath, protectedPath);

    await restoreAndVerify(client, snapshot, [protectedPath]);

    expect(readFileSync(protectedPath, "utf-8")).toBe("original\n");
    expect(readFileSync(outsidePath, "utf-8")).toBe("outside\n");
  });

  it("keeps protected paths in the linked task worktree isolated from main", async () => {
    const cwd = repo();
    const worktree = mkdtempSync(join(tmpdir(), "pi-implement-linked-"));
    git(cwd, "branch", "task");
    git(cwd, "worktree", "add", worktree, "task");
    const mainPlan = join(cwd, "plan.md");
    const taskPlan = join(worktree, "plan.md");
    writeFileSync(mainPlan, "main\n");
    writeFileSync(taskPlan, "task original\n");
    const client = new ExecGitClient(worktree, cwd);
    const snapshot = await captureRestoreSnapshot(client, [taskPlan]);
    writeFileSync(taskPlan, "mutated\n");

    expect(await snapshotChanged(client, snapshot, [taskPlan])).toBe(true);
    await restoreAndVerify(client, snapshot, [taskPlan]);
    expect(readFileSync(taskPlan, "utf-8")).toBe("task original\n");
    expect(readFileSync(mainPlan, "utf-8")).toBe("main\n");
    git(cwd, "worktree", "remove", "--force", worktree);
  });

  it("detects and heals changed untracked content", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    writeFileSync(join(cwd, "keep.txt"), "original\n");
    const snapshot = await captureRestoreSnapshot(client, []);
    writeFileSync(join(cwd, "keep.txt"), "mutated\n");

    expect(await snapshotChanged(client, snapshot, [])).toBe(true);
    await restoreAndVerify(client, snapshot, []);
    expect(readFileSync(join(cwd, "keep.txt"), "utf-8")).toBe("original\n");
  });

  it("records committed pre-completion worker edits in the discarded bundle", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const base = await client.head();
    writeFileSync(
      join(cwd, "committed.ts"),
      "export const committed = true;\n",
    );
    await client.stageAllExcept([]);
    expect((await client.checkpoint("worker commit", false)).exitCode).toBe(0);
    const destination = join(cwd, "bundle");

    await persistDiscardedBundle({
      git: client,
      destination,
      protectedPaths: [],
      baseSha: base,
    });

    expect(
      readFileSync(join(destination, "committed.patch"), "utf-8"),
    ).toContain("committed.ts");
  });

  it("restores pre-existing staged, unstaged, and untracked state exactly", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    writeFileSync(join(cwd, "staged.ts"), "export const staged = true;\n");
    await client.stageAllExcept([]);
    writeFileSync(join(cwd, "tracked.bin"), Buffer.from([9, 8, 7]));
    writeFileSync(join(cwd, "keep.txt"), "keep\n");
    const snapshot = await captureRestoreSnapshot(client, []);
    writeFileSync(join(cwd, "staged.ts"), "mutated\n");
    writeFileSync(join(cwd, "tracked.bin"), Buffer.from([1]));
    writeFileSync(join(cwd, "other.txt"), "remove\n");

    await restoreAndVerify(client, snapshot, []);

    expect(await client.stagedFingerprint()).toBe(snapshot.indexFingerprint);
    expect(await client.worktreeFingerprintExcept([])).toBe(
      snapshot.worktreeFingerprint,
    );
    expect(await client.nonignoredUntracked()).toEqual(["keep.txt"]);
  });
});
