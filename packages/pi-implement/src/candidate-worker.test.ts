import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvedCandidateRef,
  TaskWorkspaceManager,
} from "./candidate-worker.js";
import { ExecGitClient } from "./git.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-implement-worker-"));
  git(cwd, "init");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, "file.txt"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "chore: init");
  return cwd;
}

describe("candidate worker", () => {
  it("creates an immutable approved candidate in its owned task worktree", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const baseSha = await client.head();
    const worktreesRoot = join(root, ".pi", "worktrees");
    const worktreePath = join(worktreesRoot, "task-a");
    const branchName = "pi-implement/run/task-a";
    const manager = new TaskWorkspaceManager(client, worktreesRoot);

    await manager.ensure({
      taskId: "task-a",
      branchName,
      worktreePath,
      baseSha,
    });
    const taskGit = client.forWorktree(worktreePath);
    writeFileSync(join(worktreePath, "file.txt"), "candidate\n");
    await taskGit.stageAllExcept([]);
    await taskGit.checkpoint("feat: candidate", false);

    const candidate = await approvedCandidateRef({
      taskId: "task-a",
      git: taskGit,
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
      branchName,
      worktreePath,
      reviewReceipt: {
        candidateId: candidate.id,
        candidateCommitSha: candidate.commitSha,
        candidateTreeSha: candidate.treeSha,
        verdict: "approved",
        convergence: { round: 2, evidenceRefs: ["review.json"] },
      },
    });
    expect(await taskGit.treeAt(candidate.commitSha)).toBe(candidate.treeSha);
    expect(await client.head()).toBe(baseSha);
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
