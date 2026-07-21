import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CandidateRef, CanonicalRunState } from "./canonical-state.js";
import { ExecGitClient } from "./git.js";
import { IntegrationEngine } from "./integration-engine.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-implement-integration-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "file.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "chore: init");
  return root;
}

async function candidate(root: string): Promise<CandidateRef> {
  const gitClient = new ExecGitClient(root);
  await gitClient.ensureInfoExclude(".pi/");
  const baseSha = await gitClient.head();
  const branchName = "pi-implement/task-a";
  const worktreePath = join(root, ".pi", "task-a");
  await gitClient.createTaskBranch(branchName, baseSha);
  await gitClient.addWorktree(worktreePath, branchName);
  const taskGit = gitClient.forWorktree(worktreePath);
  writeFileSync(join(worktreePath, "file.txt"), "candidate\n");
  await taskGit.stageAllExcept([]);
  await taskGit.checkpoint("feat: candidate", false);
  const commitSha = await taskGit.head();
  const treeSha = await taskGit.treeAt(commitSha);
  return {
    id: "candidate:a",
    sourceBaseSha: baseSha,
    baseSha,
    commitSha,
    treeSha,
    branchName,
    worktreePath,
    reviewReceipt: {
      id: "review:a",
      candidateId: "candidate:a",
      candidateCommitSha: commitSha,
      candidateTreeSha: treeSha,
      verdict: "approved",
      convergence: {
        round: 1,
        outstandingFindingIds: [],
        bestOutstandingCount: 0,
        evidenceRefs: [],
      },
      assessedAt: "now",
    },
  };
}

function overallAttempt(candidateId: string, targetBaseSha: string) {
  return {
    id: "integration:overall",
    owner: { kind: "overall" as const },
    candidateId,
    targetBaseSha,
    pipelineHash: "pipeline",
    startedAt: "now",
    phase: "preparing" as const,
  } satisfies CanonicalRunState["integrationAttempts"][number];
}

function attempt(candidateId: string, targetBaseSha: string) {
  return {
    id: "integration:a",
    owner: { kind: "task" as const, taskId: "a" },
    candidateId,
    targetBaseSha,
    pipelineHash: "pipeline",
    startedAt: "now",
    phase: "preparing" as const,
  } satisfies CanonicalRunState["integrationAttempts"][number];
}

describe("IntegrationEngine", () => {
  it("prepares and fast-forwards a reviewed candidate without mutating target during preparation", async () => {
    const root = repository();
    const gitClient = new ExecGitClient(root);
    const approved = await candidate(root);
    const targetHead = await gitClient.head();
    const engine = new IntegrationEngine({
      git: gitClient,
      worktreesRoot: join(root, ".pi", "integrations"),
      targetCheckoutId: await gitClient.checkoutIdentity(),
      targetBranch: await gitClient.currentBranch(),
      protectedPaths: [],
    });

    const prepared = await engine.prepare(
      attempt(approved.id, targetHead),
      approved,
    );

    if (prepared.kind !== "prepared") {
      throw new Error(JSON.stringify(prepared));
    }
    expect(await gitClient.head()).toBe(targetHead);
    const published = await engine.publish(
      attempt(approved.id, targetHead),
      prepared.prepared,
      approved,
    );

    if (published.kind !== "landed") {
      throw new Error(JSON.stringify(published));
    }
    expect(await gitClient.head()).toBe(prepared.prepared.preparedCommitSha);
    expect(await gitClient.tree()).toBe(approved.treeSha);
    await engine.cleanup(prepared.prepared);
  });

  it("uses the same staging preparation and publication contract for overall candidates", async () => {
    const root = repository();
    const gitClient = new ExecGitClient(root);
    const approved = await candidate(root);
    const targetHead = await gitClient.head();
    const engine = new IntegrationEngine({
      git: gitClient,
      worktreesRoot: join(root, ".pi", "integrations"),
      targetCheckoutId: await gitClient.checkoutIdentity(),
      targetBranch: await gitClient.currentBranch(),
      protectedPaths: [],
    });

    const prepared = await engine.prepare(
      overallAttempt(approved.id, targetHead),
      approved,
    );
    if (prepared.kind !== "prepared") {
      throw new Error(JSON.stringify(prepared));
    }
    expect(await gitClient.head()).toBe(targetHead);
    const published = await engine.publish(
      overallAttempt(approved.id, targetHead),
      prepared.prepared,
      approved,
    );

    expect(published).toMatchObject({
      kind: "landed",
      receipt: { owner: { kind: "overall" } },
    });
    await engine.cleanup(prepared.prepared);
  });

  it("reconciles a retained preparing workspace to its target base before replaying preparation", async () => {
    const root = repository();
    const gitClient = new ExecGitClient(root);
    const approved = await candidate(root);
    const targetHead = await gitClient.head();
    const engine = new IntegrationEngine({
      git: gitClient,
      worktreesRoot: join(root, ".pi", "integrations"),
      targetCheckoutId: await gitClient.checkoutIdentity(),
      targetBranch: await gitClient.currentBranch(),
      protectedPaths: [],
    });
    const integrationAttempt = attempt(approved.id, targetHead);
    const initial = await engine.prepare(integrationAttempt, approved);
    if (initial.kind !== "prepared") {
      throw new Error(JSON.stringify(initial));
    }
    writeFileSync(join(initial.prepared.worktreePath, "file.txt"), "stale\n");

    const recovered = await engine.prepare(integrationAttempt, approved);

    expect(recovered).toMatchObject({
      kind: "reconstructed",
      prepared: { treeSha: approved.treeSha },
    });
    expect(await gitClient.head()).toBe(targetHead);
  });

  it("recreates a missing integration worktree when its owned branch exists", async () => {
    const root = repository();
    const gitClient = new ExecGitClient(root);
    const approved = await candidate(root);
    const targetHead = await gitClient.head();
    const engine = new IntegrationEngine({
      git: gitClient,
      worktreesRoot: join(root, ".pi", "integrations"),
      targetCheckoutId: await gitClient.checkoutIdentity(),
      targetBranch: await gitClient.currentBranch(),
      protectedPaths: [],
    });
    const integrationAttempt = attempt(approved.id, targetHead);
    const branchName = "pi-implement/integration/integration-a";
    await gitClient.createTaskBranch(branchName, targetHead);

    const result = await engine.prepare(integrationAttempt, approved);

    expect(result).toMatchObject({ kind: "prepared" });
  });

  it("reconciles a publication that succeeded before its receipt was persisted", async () => {
    const root = repository();
    const gitClient = new ExecGitClient(root);
    const approved = await candidate(root);
    const targetHead = await gitClient.head();
    const engine = new IntegrationEngine({
      git: gitClient,
      worktreesRoot: join(root, ".pi", "integrations"),
      targetCheckoutId: await gitClient.checkoutIdentity(),
      targetBranch: await gitClient.currentBranch(),
      protectedPaths: [],
    });
    const integrationAttempt = attempt(approved.id, targetHead);
    const preparedOutcome = await engine.prepare(integrationAttempt, approved);
    if (preparedOutcome.kind !== "prepared") {
      throw new Error(JSON.stringify(preparedOutcome));
    }
    const prepared = preparedOutcome.prepared;
    const published = await engine.publish(
      integrationAttempt,
      prepared,
      approved,
    );
    if (published.kind !== "landed") {
      throw new Error(JSON.stringify(published));
    }

    const reconstructed = await engine.reconstructPrepared(
      {
        ...integrationAttempt,
        phase: "prepared",
        preparedCommitSha: prepared.preparedCommitSha,
      },
      approved,
    );
    if (reconstructed.kind !== "reconstructed") {
      throw new Error(JSON.stringify(reconstructed));
    }
    const recovered = await engine.publish(
      integrationAttempt,
      reconstructed.prepared,
      approved,
    );

    expect(recovered).toMatchObject({
      kind: "landed",
      receipt: { integrationCommitSha: prepared.preparedCommitSha },
    });
  });

  it("requires persisted protected artifact hashes when reconciling a missing receipt", async () => {
    const root = repository();
    const gitClient = new ExecGitClient(root);
    const approved = await candidate(root);
    const targetHead = await gitClient.head();
    writeFileSync(join(root, "plan.md"), "protected\n");
    const engine = new IntegrationEngine({
      git: gitClient,
      worktreesRoot: join(root, ".pi", "integrations"),
      targetCheckoutId: await gitClient.checkoutIdentity(),
      targetBranch: await gitClient.currentBranch(),
      protectedPaths: ["plan.md"],
    });
    const integrationAttempt = attempt(approved.id, targetHead);
    const preparedOutcome = await engine.prepare(integrationAttempt, approved);
    if (preparedOutcome.kind !== "prepared") {
      throw new Error(JSON.stringify(preparedOutcome));
    }
    const protectedArtifactHashes = await engine.protectedArtifactHashes();
    const published = await engine.publish(
      integrationAttempt,
      preparedOutcome.prepared,
      approved,
      undefined,
      protectedArtifactHashes,
    );
    if (published.kind !== "landed") {
      throw new Error(JSON.stringify(published));
    }
    expect(published.receipt.protectedArtifactHashes).toEqual(
      protectedArtifactHashes,
    );
    writeFileSync(join(root, "plan.md"), "changed\n");

    const recovered = await engine.publish(
      {
        ...integrationAttempt,
        phase: "publishing",
        preparedCommitSha: preparedOutcome.prepared.preparedCommitSha,
        protectedArtifactHashes,
      },
      preparedOutcome.prepared,
      approved,
    );

    expect(recovered).toMatchObject({
      kind: "blocked",
      reason: expect.stringMatching(/Protected artifacts|receipt-missing/),
    });
  });

  it("preserves a candidate when the target has moved before preparation", async () => {
    const root = repository();
    const gitClient = new ExecGitClient(root);
    const approved = await candidate(root);
    writeFileSync(join(root, "other.txt"), "moved\n");
    git(root, "add", "other.txt");
    git(root, "commit", "-m", "feat: move target");
    const engine = new IntegrationEngine({
      git: gitClient,
      worktreesRoot: join(root, ".pi", "integrations"),
      targetCheckoutId: await gitClient.checkoutIdentity(),
      targetBranch: await gitClient.currentBranch(),
      protectedPaths: [],
    });

    const result = await engine.prepare(
      attempt(approved.id, approved.baseSha),
      approved,
    );

    expect(result).toMatchObject({
      kind: "target_moved",
      expected: approved.baseSha,
    });
    expect(await gitClient.treeAt(approved.commitSha)).toBe(approved.treeSha);
  });
});
