import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CandidateReplayEngine,
  reconciliationGateResult,
  reconciledCandidate,
  type ReplayCandidate,
} from "./candidate-replay.js";
import { ExecGitClient } from "./git.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-implement-replay-"));
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
  await client.ensureInfoExclude(".pi/");
  const baseSha = await client.head();
  const branch = `candidate-${path}`;
  const worktree = join(root, ".pi", branch);
  await client.createTaskBranch(branch, baseSha);
  await client.addWorktree(worktree, branch);
  const workspace = client.forWorktree(worktree);
  writeFileSync(join(worktree, path), content);
  await workspace.stageAllExcept([]);
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
    expect(reconciledCandidate(second, preparedSecond.staging)).toMatchObject({
      baseSha: preparedSecond.staging.targetBaseSha,
      commitSha: preparedSecond.staging.preparedCommitSha,
      treeSha: preparedSecond.staging.treeSha,
    });
    await replay.cleanup(preparedFirst.staging);
    await replay.cleanup(preparedSecond.staging);
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
