import { execFileSync } from "node:child_process";
import { ensureGitInfoExclude } from "#lib/git";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CandidateReplayEngine,
  publicationPreparation,
  type ReplayCandidate,
  type ReplayStaging,
} from "./candidate-replay.js";
import { ExecGitClient } from "./git.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

const temporaryDirectories = new Set<string>();

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-implement-replay-"));
  temporaryDirectories.add(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "candidate.txt"), "base\n");
  writeFileSync(join(root, "target.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "chore: init");
  return root;
}

async function candidate(
  root: string,
  path: string,
  content: string,
): Promise<ReplayCandidate> {
  const client = new ExecGitClient(root);
  await ensureGitInfoExclude(root, "/.pi/pipkin/implement/");
  const baseSha = await client.head();
  const index = join(
    root,
    ".git",
    `candidate-index-${path.replace(/[^a-z0-9]/gi, "-")}`,
  );
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    execFileSync("git", ["read-tree", baseSha], { cwd: root, env });
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      env,
      input: content,
      encoding: "utf-8",
    }).trim();
    execFileSync(
      "git",
      ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`],
      { cwd: root, env },
    );
    const treeSha = execFileSync("git", ["write-tree"], {
      cwd: root,
      env,
      encoding: "utf-8",
    }).trim();
    const commitSha = execFileSync(
      "git",
      ["commit-tree", treeSha, "-p", baseSha, "-m", `feat: ${path}`],
      { cwd: root, env, encoding: "utf-8" },
    ).trim();
    return {
      id: `candidate:${path}`,
      baseSha,
      commitSha,
      treeSha,
    };
  } finally {
    rmSync(index, { force: true });
  }
}

function engine(root: string): CandidateReplayEngine {
  return new CandidateReplayEngine({
    git: new ExecGitClient(root),
    worktreesRoot: join(
      root,
      ".pi",
      "pipkin",
      "implement",
      "worktrees",
      "run-1",
    ),
    runId: "run-1",
  });
}

async function removeStaging(
  root: string,
  staging: ReplayStaging,
): Promise<void> {
  const client = new ExecGitClient(root);
  const workspace = client.forWorktree(staging.worktreePath);
  await workspace.abortActiveOperation();
  await workspace.resetHard(staging.targetBaseSha);
  await workspace.restoreWorktreeFromIndexExcept([]);
  await client.removeWorktree(staging.worktreePath);
  await client.deleteTaskBranch(staging.branchName);
}

function preCommit(root: string, script: string): void {
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, `#!/bin/sh\n${script}\n`);
  chmodSync(hook, 0o755);
}

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe("CandidateReplayEngine", () => {
  it("allows exact tracked projection dirt but rejects unrelated target dirt", async () => {
    const root = repository();
    const plan = join(root, "plan.md");
    writeFileSync(plan, "- [ ] Task\n");
    git(root, "add", "plan.md");
    git(root, "commit", "-m", "docs: add plan");
    const approved = await candidate(root, "candidate.txt", "candidate\n");
    writeFileSync(plan, "- [x] Task\n");
    const protectedEngine = new CandidateReplayEngine({
      git: new ExecGitClient(root),
      worktreesRoot: join(
        root,
        ".pi",
        "pipkin",
        "implement",
        "worktrees",
        "run-1",
      ),
      runId: "run-1",
      protectedPaths: [plan],
      protectedArtifactsMatch: () => true,
    });

    const prepared = await protectedEngine.prepare(
      approved,
      "feat: publish candidate",
    );
    expect(prepared).toMatchObject({ kind: "prepared" });
    if (prepared.kind === "prepared") {
      await removeStaging(root, prepared.staging);
    }

    await expect(
      new CandidateReplayEngine({
        git: new ExecGitClient(root),
        worktreesRoot: join(
          root,
          ".pi",
          "pipkin",
          "implement",
          "worktrees",
          "run-2",
        ),
        runId: "run-2",
        protectedPaths: [plan],
      }).prepare(approved, "feat: publish candidate"),
    ).resolves.toMatchObject({
      kind: "infrastructure_failure",
      evidence: expect.stringContaining("requires exact retained hashes"),
    });

    git(root, "add", "plan.md");
    await expect(
      protectedEngine.prepare(approved, "feat: publish candidate"),
    ).resolves.toMatchObject({
      kind: "infrastructure_failure",
      evidence: expect.stringContaining("clean outside sanctioned artifacts"),
    });
    git(root, "reset", "--", "plan.md");

    writeFileSync(join(root, "unrelated.txt"), "operator change\n");
    await expect(
      protectedEngine.prepare(approved, "feat: publish candidate"),
    ).resolves.toMatchObject({
      kind: "infrastructure_failure",
      evidence: expect.stringContaining("clean outside sanctioned artifacts"),
    });
  });

  it("prepares a clean candidate in disposable staging without touching the target", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const approved = await candidate(root, "candidate.txt", "candidate\n");
    const before = {
      head: await client.head(),
      branch: await client.currentBranch(),
      tree: await client.tree(),
    };

    const result = await engine(root).prepare(
      approved,
      "feat: publish candidate",
    );

    expect(result).toMatchObject({
      kind: "prepared",
      disposition: "same_base",
      staging: { targetBaseSha: before.head },
    });
    if (result.kind !== "prepared") {
      throw new Error(JSON.stringify(result));
    }
    expect(await client.head()).toBe(before.head);
    expect(await client.currentBranch()).toBe(before.branch);
    expect(await client.tree()).toBe(before.tree);
    expect(result.staging.treeSha).toBe(approved.treeSha);
    expect(
      git(result.staging.worktreePath, "log", "-1", "--format=%s").trim(),
    ).toBe("feat: publish candidate");
    await removeStaging(root, result.staging);
  });

  it("reruns hooks when a staging commit has no durable preparation", async () => {
    const root = repository();
    const approved = await candidate(root, "candidate.txt", "candidate\n");
    const marker = join(root, ".git", "hook-runs");
    preCommit(root, `echo ran >> "${marker}"`);
    const replay = engine(root);

    const first = await replay.prepare(approved, "feat: publish candidate");
    expect(first.kind).toBe("prepared");
    const second = await replay.prepare(approved, "feat: publish candidate");
    expect(second.kind).toBe("prepared");
    expect(readFileSync(marker, "utf-8").trim().split("\n")).toHaveLength(2);
    if (second.kind !== "prepared") {
      throw new Error(JSON.stringify(second));
    }
    await removeStaging(root, second.staging);
  });

  it("recreates failed staging without carrying ignored hook state into a retry", async () => {
    const root = repository();
    writeFileSync(join(root, ".gitignore"), ".hook-state\n");
    git(root, "add", ".gitignore");
    git(root, "commit", "-m", "chore: ignore hook state");
    const approved = await candidate(root, "candidate.txt", "candidate\n");
    preCommit(
      root,
      "if [ -f .hook-state ]; then echo stale hook state >&2; exit 1; fi\ntouch .hook-state",
    );
    const replay = engine(root);

    const first = await replay.prepare(approved, "feat: publish candidate");
    expect(first.kind).toBe("prepared");
    const second = await replay.prepare(approved, "feat: publish candidate");
    expect(second.kind).toBe("prepared");
    if (second.kind !== "prepared") {
      throw new Error(JSON.stringify(second));
    }
    await removeStaging(root, second.staging);
  });

  it("retains hook rejection evidence without touching the target", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const approved = await candidate(root, "candidate.txt", "candidate\n");
    const target = await client.head();
    preCommit(
      root,
      "printf hook\\n >> target.txt\ngit add target.txt\necho rejected >&2\nexit 1",
    );

    const result = await engine(root).prepare(
      approved,
      "feat: publish candidate",
    );

    expect(result).toMatchObject({
      kind: "hook_rejected",
      command: { cwd: expect.stringContaining("staging"), exitCode: 1 },
    });
    if (result.kind !== "hook_rejected") {
      throw new Error(JSON.stringify(result));
    }
    expect(result.command.command).not.toContain("--no-verify");
    expect(result.command.output).toContain("rejected");
    expect(result.staging.replayPatch).toContain("+hook");
    expect(result.staging.replayPaths).toEqual(["candidate.txt", "target.txt"]);
    expect(result.staging.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(
      git(root, "diff", target, result.staging.treeSha!, "--", "target.txt"),
    ).toContain("+hook");
    expect(await client.head()).toBe(target);
    await removeStaging(root, result.staging);
  });

  it("requires reconciliation review when a commit hook changes the replayed patch", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const approved = await candidate(root, "candidate.txt", "candidate\n");
    preCommit(root, "printf hook\\n >> target.txt\ngit add target.txt");

    const result = await engine(root).prepare(
      approved,
      "feat: publish candidate",
    );

    expect(result).toMatchObject({
      kind: "reconciliation_required",
      disposition: "changed_patch",
      hookMutated: true,
      staging: { hookCommand: expect.objectContaining({ exitCode: 0 }) },
    });
    if (result.kind !== "reconciliation_required") {
      throw new Error(JSON.stringify(result));
    }
    expect(result.staging.preparedCommitSha).toBeDefined();
    expect(result.staging.replayPaths).toEqual(["candidate.txt", "target.txt"]);
    expect(await client.head()).toBe(approved.baseSha);
    await removeStaging(root, result.staging);
  });

  it("replays a historical candidate after a non-overlapping publication", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const first = await candidate(root, "candidate.txt", "first\n");
    const second = await candidate(root, "target.txt", "second\n");
    git(root, "merge", "--ff-only", first.commitSha);

    const preparedSecond = await engine(root).prepare(
      second,
      "feat: publish target change",
    );

    expect(preparedSecond).toMatchObject({
      kind: "prepared",
      disposition: "clean_non_overlap",
      staging: { targetBaseSha: await client.head() },
    });
    if (preparedSecond.kind !== "prepared") {
      throw new Error(JSON.stringify(preparedSecond));
    }
    expect(preparedSecond.staging.treeSha).not.toBe(second.treeSha);
    expect(
      publicationPreparation(
        {
          runId: "run-1",
          candidate: second,
          disposition: preparedSecond.disposition,
          targetRef: "refs/heads/master",
          hookEvidence: "git commit completed with retained command evidence",
          hookCommand: {
            command: "git commit",
            cwd: preparedSecond.staging.worktreePath,
            timedOut: false,
            output: "",
            exitCode: 0,
          },
        },
        preparedSecond.staging,
      ),
    ).toMatchObject({
      candidateId: second.id,
      candidateCommitSha: second.commitSha,
      targetBaseSha: preparedSecond.staging.targetBaseSha,
      preparedCommitSha: preparedSecond.staging.preparedCommitSha,
      preparedTreeSha: preparedSecond.staging.treeSha,
    });
    await removeStaging(root, preparedSecond.staging);
  });

  it("reprepares mismatched staging instead of accepting it", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const approved = await candidate(root, "candidate.txt", "candidate\n");
    const replay = engine(root);
    const first = await replay.prepare(approved, "feat: publish candidate");
    if (first.kind !== "prepared") {
      throw new Error(JSON.stringify(first));
    }
    const retained = publicationPreparation(
      {
        runId: "run-1",
        candidate: approved,
        disposition: first.disposition,
        targetRef: "refs/heads/master",
        hookEvidence: "git commit completed with retained command evidence",
        hookCommand: {
          command: "git commit",
          cwd: first.staging.worktreePath,
          timedOut: false,
          output: "",
          exitCode: 0,
        },
      },
      first.staging,
    );
    const staging = client.forWorktree(first.staging.worktreePath);
    writeFileSync(join(first.staging.worktreePath, "candidate.txt"), "wrong\n");
    git(first.staging.worktreePath, "add", "candidate.txt");
    await staging.checkpoint("feat: wrong", false);

    const reused = await replay.prepare(
      approved,
      "feat: publish candidate",
      undefined,
      retained,
    );

    expect(reused).toMatchObject({
      kind: "prepared",
      staging: { treeSha: approved.treeSha },
    });
    if (reused.kind !== "prepared") {
      throw new Error(JSON.stringify(reused));
    }
    expect(reused.staging.hookCommand).toMatchObject({
      command: expect.stringContaining("git commit"),
      exitCode: 0,
    });
    await removeStaging(root, reused.staging);
  });

  it("retains staging for reconciliation when intervening target paths overlap", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const approved = await candidate(root, "candidate.txt", "candidate\n");
    writeFileSync(join(root, "candidate.txt"), "target\n");
    git(root, "add", "candidate.txt");
    git(root, "commit", "-m", "feat: target overlap");

    const result = await engine(root).prepare(
      approved,
      "feat: publish candidate",
    );

    expect(result).toMatchObject({
      kind: "reconciliation_required",
      disposition: "conflict",
      staging: {
        candidatePaths: ["candidate.txt"],
        targetPaths: ["candidate.txt"],
      },
    });
    if (result.kind !== "reconciliation_required") {
      throw new Error(JSON.stringify(result));
    }
    expect(await client.head()).not.toBe(approved.baseSha);
    await removeStaging(root, result.staging);
  });

  it("cancels before creating staging worktrees", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const baseSha = await client.head();
    const controller = new AbortController();
    controller.abort();

    const result = await engine(root).prepare(
      {
        id: "candidate:cancelled",
        baseSha,
        commitSha: baseSha,
        treeSha: await client.tree(),
      },
      undefined,
      controller.signal,
    );

    expect(result).toEqual({ kind: "cancelled" });
    expect(await client.listWorktrees()).toEqual([realpathSync(root)]);
  });

  it("requires a fresh repository assessment for a stale already-satisfied candidate", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const baseSha = await client.head();
    writeFileSync(join(root, "target.txt"), "new target\n");
    git(root, "add", "target.txt");
    git(root, "commit", "-m", "feat: target change");

    const result = await engine(root).prepare({
      id: "satisfied:workstream",
      baseSha,
      commitSha: baseSha,
      treeSha: await client.treeAt(baseSha),
    });

    expect(result).toMatchObject({ kind: "repository_assessment_required" });
    if (result.kind !== "repository_assessment_required") {
      throw new Error(JSON.stringify(result));
    }
    await removeStaging(root, result.staging);
  });
});
