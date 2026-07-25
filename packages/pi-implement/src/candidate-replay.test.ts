import { execFileSync } from "node:child_process";
import { ensureGitInfoExclude } from "@pi-extensions/lib";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CandidateReplayEngine,
  publicationPreparation,
  reconciliationGateResult,
  type ReplayCandidate,
} from "./candidate-replay.js";
import { ExecGitClient } from "./git.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

const temporaryDirectories = new Set<string>();

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-implement-replay-"));
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
  await ensureGitInfoExclude(root, ".pi/");
  const baseSha = await client.head();
  const branch = `candidate-${path}`;
  const worktree = join(root, ".pi", branch);
  await client.createTaskBranch(branch, baseSha);
  await client.addWorktree(worktree, branch);
  const workspace = client.forWorktree(worktree);
  writeFileSync(join(worktree, path), content);
  git(worktree, "add", "-A");
  await workspace.checkpoint(`feat: ${path}`, false);
  const commitSha = await workspace.head();
  return {
    id: `candidate:${path}`,
    baseSha,
    commitSha,
    treeSha: await workspace.treeAt(commitSha),
  };
}

function engine(root: string): CandidateReplayEngine {
  return new CandidateReplayEngine({
    git: new ExecGitClient(root),
    worktreesRoot: join(root, ".pi", "implement", "worktrees", "run-1"),
    runId: "run-1",
  });
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
  it("prepares a clean candidate in disposable staging without touching the target", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const approved = await candidate(root, "candidate.txt", "candidate\n");
    const before = {
      head: await client.head(),
      branch: await client.currentBranch(),
      tree: await client.tree(),
    };

    const result = await engine(root).prepare(approved);

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
      reconciliationGateResult({
        outcome: result,
        owner: "source:workstream",
        candidateId: approved.id,
        attempt: 1,
      }),
    ).toMatchObject({ kind: "reconciliation", outcome: "passed" });
    await engine(root).cleanup(result.staging);
  });

  it("retains hook rejection evidence without touching the target", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const approved = await candidate(root, "candidate.txt", "candidate\n");
    const target = await client.head();
    preCommit(root, "echo rejected >&2\nexit 1");

    const result = await engine(root).prepare(approved);

    expect(result).toMatchObject({
      kind: "hook_rejected",
      command: { cwd: expect.stringContaining("staging"), exitCode: 1 },
    });
    if (result.kind !== "hook_rejected") {
      throw new Error(JSON.stringify(result));
    }
    expect(result.command.command).not.toContain("--no-verify");
    expect(result.command.output).toContain("rejected");
    expect(await client.head()).toBe(target);
    await engine(root).discard(result.staging);
  });

  it("requires reconciliation review when a commit hook changes the replayed patch", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const approved = await candidate(root, "candidate.txt", "candidate\n");
    preCommit(root, "printf hook\\n >> target.txt\ngit add target.txt");

    const result = await engine(root).prepare(approved);

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
    await engine(root).discard(result.staging);
  });

  it("replays two historical candidates serially when target changes do not overlap", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const first = await candidate(root, "candidate.txt", "first\n");
    const second = await candidate(root, "target.txt", "second\n");
    const replay = engine(root);

    const preparedFirst = await replay.prepare(first);
    if (preparedFirst.kind !== "prepared") {
      throw new Error(JSON.stringify(preparedFirst));
    }
    git(root, "merge", "--ff-only", preparedFirst.staging.preparedCommitSha);
    const preparedSecond = await replay.prepare(second);

    expect(preparedSecond).toMatchObject({
      kind: "prepared",
      disposition: "clean_non_overlap",
      staging: { targetBaseSha: await client.head() },
    });
    if (preparedSecond.kind !== "prepared") {
      throw new Error(JSON.stringify(preparedSecond));
    }
    expect(preparedSecond.staging.treeSha).not.toBe(second.treeSha);
    expect(preparedSecond.staging.id).not.toBe(preparedFirst.staging.id);
    expect(preparedSecond.staging.branchName).not.toBe(
      preparedFirst.staging.branchName,
    );
    expect(
      publicationPreparation(
        {
          runId: "run-1",
          candidate: second,
          disposition: preparedSecond.disposition,
          targetRef: "refs/heads/master",
          hookEvidence: "git commit completed with retained command evidence",
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
    await replay.cleanup(preparedFirst.staging);
    await replay.cleanup(preparedSecond.staging);
  });

  it("reprepares legacy or mismatched staging instead of accepting it", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const approved = await candidate(root, "candidate.txt", "candidate\n");
    const replay = engine(root);
    const first = await replay.prepare(approved);
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
      },
      first.staging,
    );
    const staging = client.forWorktree(first.staging.worktreePath);
    writeFileSync(join(first.staging.worktreePath, "candidate.txt"), "wrong\n");
    git(first.staging.worktreePath, "add", "candidate.txt");
    await staging.checkpoint("feat: wrong", false);

    const reused = await replay.prepare(approved, undefined, retained);

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
    await replay.cleanup(reused.staging);
  });

  it("retains staging for reconciliation when intervening target paths overlap", async () => {
    const root = repository();
    const client = new ExecGitClient(root);
    const approved = await candidate(root, "candidate.txt", "candidate\n");
    writeFileSync(join(root, "candidate.txt"), "target\n");
    git(root, "add", "candidate.txt");
    git(root, "commit", "-m", "feat: target overlap");

    const result = await engine(root).prepare(approved);

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
    expect(
      reconciliationGateResult({
        outcome: result,
        owner: "source:workstream",
        candidateId: approved.id,
        attempt: 1,
      }),
    ).toMatchObject({ kind: "reconciliation", outcome: "failed" });
    await engine(root).discard(result.staging);
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
    await engine(root).discard(result.staging);
  });
});
