import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureRestoreSnapshot,
  checkpointCandidate,
  restoreAndVerify,
  snapshotChanged,
} from "./candidate.js";
import { ExecGitClient } from "./git.js";

const temporaryDirectories = new Set<string>();

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.add(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function repo(): string {
  const cwd = temporaryDirectory("pi-implement-candidate-");
  git(cwd, "init");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, "tracked.bin"), Buffer.from([0, 1, 2]));
  git(cwd, "add", "tracked.bin");
  git(cwd, "commit", "-m", "chore: init");
  return cwd;
}

afterEach(() => {
  for (const path of temporaryDirectories) {
    rmSync(path, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

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
    expect((await checkpointCandidate(client, first.candidate)).changed).toBe(
      false,
    );

    writeFileSync(join(cwd, "second.ts"), "export const second = true;\n");
    await client.stageAllExcept([]);
    const second = await checkpointCandidate(client, first.candidate);
    expect(second.changed).toBe(true);
    expect(git(cwd, "rev-list", "--count", `${base}..HEAD`).trim()).toBe("1");
  });

  it("restores target and protected artifacts after reviewer changes", async () => {
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
    expect(readFileSync(join(cwd, "tracked.bin"))).toEqual(
      Buffer.from([0, 1, 2]),
    );
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
    rmSync(protectedPath);
    symlinkSync(outsidePath, protectedPath);

    await restoreAndVerify(client, snapshot, [protectedPath]);

    expect(readFileSync(protectedPath, "utf-8")).toBe("original\n");
    expect(readFileSync(outsidePath, "utf-8")).toBe("outside\n");
  });

  it("keeps protected paths in a linked worktree isolated from the target", async () => {
    const cwd = repo();
    const worktree = temporaryDirectory("pi-implement-linked-");
    git(cwd, "branch", "task");
    git(cwd, "worktree", "add", worktree, "task");
    try {
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
    } finally {
      git(cwd, "worktree", "remove", "--force", worktree);
    }
  });
});
