import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskWorkspaceManager } from "./candidate-worker.js";
import { ExecGitClient } from "./git.js";

const temporaryDirectories = new Set<string>();

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pipkin-implement-worker-"));
  temporaryDirectories.add(cwd);
  execFileSync("git", ["init"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  writeFileSync(join(cwd, "file.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-m", "chore: init"], { cwd });
  return cwd;
}

afterEach(() => {
  for (const path of temporaryDirectories) {
    rmSync(path, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("TaskWorkspaceManager", () => {
  it("recreates a disposable workspace from its committed checkpoint", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const baseSha = await client.head();
    const worktreesRoot = join(root, ".pi", "worktrees");
    const workspace = {
      taskId: "task-a",
      branchName: "pipkin/implement/run/task-a",
      worktreePath: join(worktreesRoot, "task-a"),
      baseSha,
    };
    const manager = new TaskWorkspaceManager(client, worktreesRoot);

    await manager.ensure(workspace);
    const taskGit = client.forWorktree(workspace.worktreePath);
    writeFileSync(join(workspace.worktreePath, "file.txt"), "candidate\n");
    execFileSync("git", ["add", "-A"], { cwd: workspace.worktreePath });
    await taskGit.checkpoint("feat: candidate", false);
    const checkpoint = await taskGit.head();

    await manager.recreate(workspace, checkpoint);
    const recreated = client.forWorktree(workspace.worktreePath);
    expect(await recreated.head()).toBe(checkpoint);
    expect(await recreated.isClean()).toBe(true);

    await manager.remove(workspace, checkpoint);
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
        branchName: "pipkin/implement/run/task-a",
        worktreePath: join(root, "outside"),
        baseSha: await client.head(),
      }),
    ).rejects.toThrow("outside the owned worktree root");
  });
});
