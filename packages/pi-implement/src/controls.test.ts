import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskWorkspaceManager } from "./candidate-worker.js";
import { ExecGitClient } from "./git.js";
import { sweepOwnedRunResources } from "./cleanup.js";
import { checkoutPaths, type RunState, type RunStore } from "./store.js";
import { assertProspectiveRunPreflight, listCheckoutRuns } from "./controls.js";

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-implement-controls-git-"));
  temporaryDirectories.add(root);
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "file.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "chore: init"], { cwd: root });
  return root;
}

describe(" controls", () => {
  it("requires a clean named branch with no active Git operation before starting", async () => {
    const root = repository();
    const git = new ExecGitClient(root);

    await expect(assertProspectiveRunPreflight(git)).resolves.toBeUndefined();

    writeFileSync(join(root, "unrelated.txt"), "operator dirt\n");
    await expect(assertProspectiveRunPreflight(git)).rejects.toThrow(
      "clean target checkout",
    );
    rmSync(join(root, "unrelated.txt"));

    const branch = await git.currentBranch();
    execFileSync("git", ["checkout", "--detach"], { cwd: root });
    await expect(assertProspectiveRunPreflight(git)).rejects.toThrow(
      "named local branch",
    );
    execFileSync("git", ["checkout", branch], { cwd: root });

    writeFileSync(join(root, ".git", "MERGE_HEAD"), await git.head());
    await expect(assertProspectiveRunPreflight(git)).rejects.toThrow(
      "active merge operation",
    );
    rmSync(join(root, ".git", "MERGE_HEAD"));
  });

  it("removes discovered namespaced resources and tolerates a repeated partial cleanup", async () => {
    const root = repository();
    const git = new ExecGitClient(root);
    const baseSha = await git.head();
    const paths = checkoutPaths(root);
    const workspace = {
      taskId: "task-a",
      branchName: "pi-implement/run-1/task-a",
      worktreePath: join(paths.worktrees, "run-1", "task-a"),
      baseSha,
    };
    await new TaskWorkspaceManager(git, join(paths.worktrees, "run-1")).ensure(
      workspace,
    );
    const workspaceGit = git.forWorktree(workspace.worktreePath);
    writeFileSync(join(workspace.worktreePath, "file.txt"), "candidate\n");
    execFileSync("git", ["add", "."], { cwd: workspace.worktreePath });
    await workspaceGit.checkpoint("feat: candidate", false);
    const candidateSha = await workspaceGit.head();
    const state = {
      run: { id: "run-1", checkout: { root } },
      candidates: {
        candidate: {
          workstream: { kind: "source", id: "task-a" },
          commitSha: candidateSha,
        },
      },
      publication: { preparations: {} },
    } as unknown as RunState;
    const lease = {
      paths,
      owner: { runId: "run-1" },
      assertOwned() {},
    } as never;
    const store = { read: () => state } as RunStore;

    await sweepOwnedRunResources({ lease, store, git });
    await sweepOwnedRunResources({ lease, store, git });

    expect(await git.listBranchesMatching("pi-implement/run-1/*")).toEqual([]);
    expect(
      (await git.listWorktrees()).some(
        (path) => path === workspace.worktreePath,
      ),
    ).toBe(false);
  });

  it("reports malformed retained directories as manual-only historical artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-implement-controls-"));
    temporaryDirectories.add(root);
    const path = join(checkoutPaths(root).runs, "old-run");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "run-state.json"), "historical state");

    expect(listCheckoutRuns(root)).toEqual([
      { kind: "historical", runId: "old-run" },
    ]);
  });
});
