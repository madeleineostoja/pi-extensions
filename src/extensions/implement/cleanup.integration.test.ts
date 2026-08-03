import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { releaseCompletedRunResources } from "./controls.js";
import { ExecGitClient } from "./git.js";
import {
  checkoutPaths,
  type CheckoutLeaseCapability,
  type RunState,
  type RunStore,
} from "./store.js";

const temporaryDirectories = new Set<string>();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pipkin-implement-cleanup-"));
  temporaryDirectories.add(cwd);
  git(cwd, "init");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, "tracked.ts"), "export const value = 1;\n");
  git(cwd, "add", "tracked.ts");
  git(cwd, "commit", "-m", "chore: init");
  return cwd;
}

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("completed run resource release", () => {
  it("removes owned worktrees and branches while retaining run evidence", async () => {
    const root = realpathSync(repo());
    const runId = "run-1";
    const workstreamId = "task";
    const paths = checkoutPaths(root);
    const runDirectory = join(paths.runs, runId);
    const worktree = join(paths.worktrees, runId, workstreamId);
    const branch = `pipkin/implement/${runId}/${workstreamId}`;
    const stagingBranch = `pipkin/implement/${runId}/staging-abcd`;
    const stagingWorktree = join(paths.worktrees, runId, "staging-abcd");
    const head = git(root, "rev-parse", "HEAD");
    const gitDir = realpathSync(
      git(root, "rev-parse", "--path-format=absolute", "--git-dir"),
    );
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, "evidence.json"), "{}\n");
    git(root, "branch", branch, head);
    git(root, "worktree", "add", worktree, branch);
    git(root, "branch", stagingBranch, head);
    git(root, "worktree", "add", stagingWorktree, stagingBranch);

    const state = {
      phase: "completed",
      processLeases: {},
      run: { id: runId, checkout: { root, gitDir } },
      candidates: {
        candidate: {
          workstream: { kind: "source", id: workstreamId },
          commitSha: head,
        },
      },
      publication: { preparations: {} },
      satisfaction: { assessments: {} },
    } as unknown as RunState;
    const lease = {
      paths,
      owner: {
        runId,
        runPath: runDirectory,
        checkoutRoot: root,
        gitDir,
        pid: process.pid,
        hostname: "test",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      assertOwned() {},
      async release() {},
    } satisfies CheckoutLeaseCapability;
    const store = { read: () => state } as unknown as RunStore;

    await releaseCompletedRunResources({
      lease,
      store,
      git: new ExecGitClient(root),
    });

    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(stagingWorktree)).toBe(false);
    expect(git(root, "branch", "--list", branch)).toBe("");
    expect(git(root, "branch", "--list", stagingBranch)).toBe("");
    expect(existsSync(join(runDirectory, "evidence.json"))).toBe(true);
  });
});
