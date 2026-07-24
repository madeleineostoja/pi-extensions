import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvedCandidateRef,
  TaskWorkspaceManager,
} from "./candidate-worker.js";
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

function repository(): string {
  const cwd = temporaryDirectory("pi-implement-worker-");
  git(cwd, "init");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, "file.txt"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "chore: init");
  return cwd;
}

afterEach(() => {
  for (const path of temporaryDirectories) {
    rmSync(path, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("candidate worker", () => {
  it("recreates a disposable workspace from its committed approved candidate", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const baseSha = await client.head();
    const worktreesRoot = join(root, ".pi", "worktrees");
    const worktreePath = join(worktreesRoot, "task-a");
    const branchName = "pi-implement/run/task-a";
    const workspace = { taskId: "task-a", branchName, worktreePath, baseSha };
    const manager = new TaskWorkspaceManager(client, worktreesRoot);
    let candidateHead = baseSha;
    let workspaceRegistered = false;
    let branchCreated = false;
    let cleanupError: unknown;

    try {
      await manager.ensure(workspace);
      workspaceRegistered = true;
      branchCreated = true;
      const taskGit = client.forWorktree(worktreePath);
      writeFileSync(join(worktreePath, "file.txt"), "candidate\n");
      await taskGit.stageAllExcept([]);
      await taskGit.checkpoint("feat: candidate", false);
      candidateHead = await taskGit.head();

      await client.removeWorktree(worktreePath);
      workspaceRegistered = false;
      await manager.ensure(workspace, { existingBranch: true });
      workspaceRegistered = true;
      const recreatedGit = client.forWorktree(worktreePath);
      expect(await recreatedGit.head()).toBe(candidateHead);
      expect(await recreatedGit.isClean()).toBe(true);

      const candidate = await approvedCandidateRef({
        taskId: "task-a",
        git: recreatedGit,
        sourceBaseSha: baseSha,
        baseSha,
        branchName,
        worktreePath,
        review: {
          lastDecision: "reviewed",
          convergence: {
            epoch: 1,
            closedEpochs: [],
            state: {
              round: 2,
              findings: [],
              outstandingIds: [],
              bestOutstandingCount: 0,
              consecutiveStalledRounds: 0,
            },
          },
        },
        artifactRefs: ["review.json"],
        protectedPaths: [],
        assessedAt: "now",
      });

      expect(candidate).toMatchObject({
        sourceBaseSha: baseSha,
        baseSha,
        commitSha: candidateHead,
        branchName,
        worktreePath,
      });
      expect(await client.head()).toBe(baseSha);
    } finally {
      try {
        if (workspaceRegistered) {
          await manager.remove(workspace, candidateHead);
        } else if (branchCreated) {
          await client.deleteTaskBranch(branchName);
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) {
      throw cleanupError;
    }
  });

  it("rejects candidate worktrees outside its owned namespace", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const manager = new TaskWorkspaceManager(
      client,
      join(root, ".pi", "worktrees"),
    );

    await expect(
      manager.ensure({
        taskId: "task-a",
        branchName: "pi-implement/run/task-a",
        worktreePath: join(root, "outside"),
        baseSha: await client.head(),
      }),
    ).rejects.toThrow("outside the owned worktree root");
  });
});
