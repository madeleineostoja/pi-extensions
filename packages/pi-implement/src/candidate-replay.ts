import { resolve } from "node:path";
import { TaskWorkspaceManager } from "./candidate-worker.js";
import { sha256 } from "./source-integrity.js";
import { changedPathsBetween, type GitClient } from "./git.js";
import type { RecoveryGateResult } from "./recovery-vnext.js";

export type ReplayCandidate = {
  id: string;
  baseSha: string;
  commitSha: string;
  treeSha: string;
};

export type ReplayStaging = {
  id: string;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  preparedCommitSha?: string;
  treeSha?: string;
  candidateId: string;
  candidateCommitSha: string;
  replayPatch?: string;
  replayPatchHash?: string;
  candidatePaths: string[];
  targetPaths: string[];
  replayPaths?: string[];
};

export type PublicationPreparation = {
  id: string;
  candidateId: string;
  candidateCommitSha: string;
  targetBaseSha: string;
  targetRef: string;
  preparedCommitSha: string;
  preparedTreeSha: string;
  stagingWorktree: string;
  stagingBranch: string;
  replayPatchHash: string;
  changedPaths: string[];
  disposition: "same_base" | "clean_non_overlap";
  hookEvidence: string;
};

export function stagingIdentity(args: {
  runId: string;
  candidateId: string;
  candidateCommitSha: string;
  targetBaseSha: string;
}): { id: string; branchName: string } {
  const id = `staging-${sha256(
    `${args.runId}\0${args.candidateId}\0${args.candidateCommitSha}\0${args.targetBaseSha}`,
  )}`;
  return { id, branchName: `pi-implement/${args.runId}/${id}` };
}

export function publicationPreparationId(args: {
  runId: string;
  candidateId: string;
  candidateCommitSha: string;
  targetBaseSha: string;
}): string {
  return `preparation-${sha256(
    `${args.runId}\0${args.candidateId}\0${args.candidateCommitSha}\0${args.targetBaseSha}`,
  )}`;
}

export type CandidateReplayOutcome =
  | {
      kind: "prepared";
      disposition: "same_base" | "clean_non_overlap";
      staging: ReplayStaging & { preparedCommitSha: string; treeSha: string };
    }
  | {
      kind: "reconciliation_required";
      disposition: "overlap" | "conflict" | "changed_patch";
      staging: ReplayStaging;
      evidence: string;
    }
  | {
      kind: "repository_assessment_required";
      staging: ReplayStaging;
      evidence: string;
    }
  | { kind: "cancelled"; staging?: ReplayStaging }
  | {
      kind: "infrastructure_failure";
      evidence: string;
      staging?: ReplayStaging;
    };

export function reconciliationGateResult(args: {
  outcome: CandidateReplayOutcome;
  owner: string;
  candidateId: string;
  attempt: number;
}): RecoveryGateResult | undefined {
  if (args.outcome.kind === "prepared") {
    return {
      id: `reconciliation:${args.candidateId}:${args.attempt}`,
      kind: "reconciliation",
      owner: args.owner,
      candidateId: args.candidateId,
      attempt: args.attempt,
      outcome: "passed",
      evidence: `Prepared ${args.outcome.disposition} replay at ${args.outcome.staging.preparedCommitSha}.`,
      outstandingFindingIds: [],
    };
  }
  if (args.outcome.kind !== "reconciliation_required") {
    return undefined;
  }
  return {
    id: `reconciliation:${args.candidateId}:${args.attempt}`,
    kind: "reconciliation",
    owner: args.owner,
    candidateId: args.candidateId,
    attempt: args.attempt,
    outcome: "failed",
    evidence: args.outcome.evidence,
    outstandingFindingIds: [],
  };
}

export function publicationPreparation(
  args: {
    runId: string;
    candidate: ReplayCandidate;
    disposition: "same_base" | "clean_non_overlap";
    targetRef: string;
    hookEvidence: string;
  },
  prepared: Extract<CandidateReplayOutcome, { kind: "prepared" }>["staging"],
): PublicationPreparation {
  const replayPatchHash = prepared.replayPatchHash;
  if (!replayPatchHash) {
    throw new Error("Prepared replay is missing its immutable patch identity.");
  }
  return {
    id: publicationPreparationId({
      runId: args.runId,
      candidateId: args.candidate.id,
      candidateCommitSha: args.candidate.commitSha,
      targetBaseSha: prepared.targetBaseSha,
    }),
    candidateId: args.candidate.id,
    candidateCommitSha: args.candidate.commitSha,
    targetBaseSha: prepared.targetBaseSha,
    targetRef: args.targetRef,
    preparedCommitSha: prepared.preparedCommitSha,
    preparedTreeSha: prepared.treeSha,
    stagingWorktree: prepared.worktreePath,
    stagingBranch: prepared.branchName,
    replayPatchHash,
    changedPaths: prepared.replayPaths ?? [],
    disposition: args.disposition,
    hookEvidence: args.hookEvidence,
  };
}

export type CandidateReplayOptions = {
  git: GitClient;
  worktreesRoot: string;
  runId: string;
};

export class CandidateReplayEngine {
  private readonly workspaces: TaskWorkspaceManager;

  constructor(private readonly options: CandidateReplayOptions) {
    this.workspaces = new TaskWorkspaceManager(
      options.git,
      options.worktreesRoot,
    );
  }

  async prepare(
    candidate: ReplayCandidate,
    signal?: AbortSignal,
    retainedPreparation?: PublicationPreparation,
  ): Promise<CandidateReplayOutcome> {
    if (signal?.aborted) {
      return { kind: "cancelled" };
    }
    let retainedStaging: ReplayStaging | undefined;
    try {
      const git = this.options.git.withSignal?.(signal) ?? this.options.git;
      const target = await targetSnapshot(git);
      if (
        (await git.treeAt(candidate.commitSha)) !== candidate.treeSha ||
        !(await git.isAncestor(candidate.baseSha, candidate.commitSha)) ||
        !(await git.isAncestor(candidate.baseSha, target.head))
      ) {
        throw new Error(
          "Candidate or target no longer descends from the reviewed base.",
        );
      }
      const [candidatePaths, targetPaths, candidatePatch] = await Promise.all([
        changedPaths(this.options.git, candidate.baseSha, candidate.commitSha),
        candidate.baseSha === target.head
          ? Promise.resolve([])
          : changedPaths(this.options.git, candidate.baseSha, target.head),
        git.diffRange(candidate.baseSha, candidate.commitSha),
      ]);
      const staging = await this.ensureStaging(
        target.head,
        candidate,
        candidatePaths,
        targetPaths,
        patchHash(candidatePatch),
        retainedPreparation,
      );
      retainedStaging = staging;
      if (staging.preparedCommitSha && staging.treeSha) {
        await assertTargetUnchanged(git, target);
        return {
          kind: "prepared",
          disposition:
            candidate.baseSha === target.head
              ? "same_base"
              : "clean_non_overlap",
          staging: staging as ReplayStaging & {
            preparedCommitSha: string;
            treeSha: string;
          },
        };
      }
      if (candidate.commitSha === candidate.baseSha) {
        await assertTargetUnchanged(git, target);
        return candidate.baseSha === target.head
          ? {
              kind: "prepared",
              disposition: "same_base",
              staging: await this.commitPrepared(staging, candidate, target),
            }
          : {
              kind: "repository_assessment_required",
              staging,
              evidence:
                "The reviewed already-satisfied candidate has a stale repository base.",
            };
      }

      const overlaps = intersection(candidatePaths, targetPaths);
      const workspaceGit = git.forWorktree(staging.worktreePath);
      const patch = candidatePatch;
      const applied = await workspaceGit.applyPatch(patch);
      if (signal?.aborted) {
        await assertTargetUnchanged(git, target);
        return { kind: "cancelled", staging };
      }
      if (applied.exitCode !== 0) {
        await assertTargetUnchanged(git, target);
        return {
          kind: "reconciliation_required",
          disposition: "conflict",
          staging: {
            ...staging,
            replayPaths: overlaps,
            replayPatch: patch,
            replayPatchHash: patchHash(patch),
          },
          evidence:
            applied.stderr || applied.stdout || "Candidate replay conflicted.",
        };
      }
      if (overlaps.length > 0) {
        await assertTargetUnchanged(git, target);
        return {
          kind: "reconciliation_required",
          disposition: "overlap",
          staging: {
            ...staging,
            replayPaths: overlaps,
            replayPatch: patch,
            replayPatchHash: patchHash(patch),
          },
          evidence: `Approved candidate and intervening target changes overlap: ${overlaps.join(", ")}`,
        };
      }
      const replayPaths = (await workspaceGit.stagedNameStatus())
        .split("\n")
        .flatMap((line) => line.split("\t").slice(1))
        .filter(Boolean)
        .sort();
      const replayPatch = await workspaceGit.stagedDiff();
      if (normalizePatch(replayPatch) !== normalizePatch(patch)) {
        await assertTargetUnchanged(git, target);
        return {
          kind: "reconciliation_required",
          disposition: "changed_patch",
          staging: {
            ...staging,
            replayPaths,
            replayPatch: patch,
            replayPatchHash: patchHash(patch),
          },
          evidence:
            "Replaying the approved candidate produced a different staged patch.",
        };
      }
      const prepared = await this.commitPrepared(
        {
          ...staging,
          replayPaths,
          replayPatch: patch,
          replayPatchHash: patchHash(patch),
        },
        candidate,
        target,
      );
      return {
        kind: "prepared",
        disposition:
          candidate.baseSha === target.head ? "same_base" : "clean_non_overlap",
        staging: prepared,
      };
    } catch (error) {
      return {
        kind: "infrastructure_failure",
        evidence: error instanceof Error ? error.message : String(error),
        ...(retainedStaging ? { staging: retainedStaging } : {}),
      };
    }
  }

  async recreate(staging: ReplayStaging): Promise<void> {
    await this.workspaces.recreate(
      {
        taskId: staging.id,
        branchName: staging.branchName,
        worktreePath: staging.worktreePath,
        baseSha: staging.targetBaseSha,
      },
      staging.targetBaseSha,
    );
  }

  async discard(staging: ReplayStaging): Promise<void> {
    const stagingGit = this.options.git.forWorktree(staging.worktreePath);
    await stagingGit.abortActiveOperation();
    await stagingGit.resetHard(staging.targetBaseSha);
    await stagingGit.restoreWorktreeFromIndexExcept([]);
    await this.workspaces.remove(
      {
        taskId: staging.id,
        branchName: staging.branchName,
        worktreePath: staging.worktreePath,
        baseSha: staging.targetBaseSha,
      },
      staging.targetBaseSha,
    );
  }

  async cleanup(staging: ReplayStaging): Promise<void> {
    if (!staging.preparedCommitSha) {
      throw new Error(
        "Only a clean prepared staging workspace may be removed.",
      );
    }
    await this.workspaces.remove(
      {
        taskId: staging.id,
        branchName: staging.branchName,
        worktreePath: staging.worktreePath,
        baseSha: staging.targetBaseSha,
      },
      staging.preparedCommitSha,
    );
  }

  private async ensureStaging(
    targetBaseSha: string,
    candidate: ReplayCandidate,
    candidatePaths: string[],
    targetPaths: string[],
    candidatePatchHash: string,
    retainedPreparation?: PublicationPreparation,
  ): Promise<ReplayStaging> {
    const { id, branchName } = stagingIdentity({
      runId: this.options.runId,
      candidateId: candidate.id,
      candidateCommitSha: candidate.commitSha,
      targetBaseSha,
    });
    const worktreePath = resolve(this.options.worktreesRoot, id);
    const existingBranch = (
      await this.options.git.listBranchesMatching(branchName)
    ).includes(branchName);
    await this.workspaces.ensure(
      { taskId: id, branchName, worktreePath, baseSha: targetBaseSha },
      { existingBranch },
    );
    const stagingGit = this.options.git.forWorktree(worktreePath);
    await stagingGit.abortActiveOperation();
    if (retainedPreparation) {
      if (
        retainedPreparation.candidateId !== candidate.id ||
        retainedPreparation.candidateCommitSha !== candidate.commitSha ||
        retainedPreparation.targetBaseSha !== targetBaseSha ||
        retainedPreparation.stagingWorktree !== worktreePath ||
        retainedPreparation.stagingBranch !== branchName
      ) {
        throw new Error(
          "Retained preparation does not match its staging identity.",
        );
      }
      const [parent, tree, patch] = await Promise.all([
        stagingGit.parent(retainedPreparation.preparedCommitSha),
        stagingGit.treeAt(retainedPreparation.preparedCommitSha),
        stagingGit.diffRange(
          retainedPreparation.targetBaseSha,
          retainedPreparation.preparedCommitSha,
        ),
      ]);
      if (
        parent !== retainedPreparation.targetBaseSha ||
        tree !== retainedPreparation.preparedTreeSha ||
        patchHash(patch) !== retainedPreparation.replayPatchHash ||
        patchHash(patch) !== candidatePatchHash
      ) {
        throw new Error(
          "Retained preparation commit no longer matches its replay.",
        );
      }
      await stagingGit.resetHard(retainedPreparation.preparedCommitSha);
      await stagingGit.restoreWorktreeFromIndexExcept([]);
      if (!(await stagingGit.isClean())) {
        throw new Error(
          "Retained preparation staging cannot be restored cleanly.",
        );
      }
      return {
        id,
        worktreePath,
        branchName,
        targetBaseSha,
        candidateId: candidate.id,
        candidateCommitSha: candidate.commitSha,
        replayPatch: patch,
        replayPatchHash: patchHash(patch),
        candidatePaths,
        targetPaths,
        replayPaths: [...retainedPreparation.changedPaths],
        preparedCommitSha: retainedPreparation.preparedCommitSha,
        treeSha: retainedPreparation.preparedTreeSha,
      };
    }
    const currentHead = await stagingGit.head();
    if (
      currentHead !== targetBaseSha &&
      (await stagingGit.parent(currentHead)) === targetBaseSha &&
      (await stagingGit.isClean())
    ) {
      const replayPatch = await stagingGit.diffRange(
        targetBaseSha,
        currentHead,
      );
      const replayPaths = await changedPaths(
        stagingGit,
        targetBaseSha,
        currentHead,
      );
      if (
        patchHash(replayPatch) !== candidatePatchHash ||
        JSON.stringify(replayPaths) !== JSON.stringify(candidatePaths)
      ) {
        await stagingGit.resetHard(targetBaseSha);
      } else {
        return {
          id,
          worktreePath,
          branchName,
          targetBaseSha,
          candidateId: candidate.id,
          candidateCommitSha: candidate.commitSha,
          replayPatch,
          replayPatchHash: patchHash(replayPatch),
          candidatePaths,
          targetPaths,
          replayPaths,
          preparedCommitSha: currentHead,
          treeSha: await stagingGit.treeAt(currentHead),
        };
      }
    }
    await stagingGit.resetHard(targetBaseSha);
    await stagingGit.restoreWorktreeFromIndexExcept([]);
    if (
      !(await stagingGit.isClean()) ||
      (await stagingGit.head()) !== targetBaseSha
    ) {
      throw new Error(
        "Staging worktree could not be recreated at the current target.",
      );
    }
    return {
      id,
      worktreePath,
      branchName,
      targetBaseSha,
      candidateId: candidate.id,
      candidateCommitSha: candidate.commitSha,
      candidatePaths,
      targetPaths,
    };
  }

  private async commitPrepared(
    staging: ReplayStaging,
    candidate: ReplayCandidate,
    target: Awaited<ReturnType<typeof targetSnapshot>>,
  ): Promise<ReplayStaging & { preparedCommitSha: string; treeSha: string }> {
    const stagingGit = this.options.git.forWorktree(staging.worktreePath);
    if (!(await stagingGit.hasStagedChanges())) {
      if (candidate.commitSha !== candidate.baseSha) {
        throw new Error("Candidate replay unexpectedly has no staged changes.");
      }
      await assertTargetUnchanged(this.options.git, target);
      return {
        ...staging,
        replayPatch: "",
        replayPatchHash: patchHash(""),
        replayPaths: [],
        preparedCommitSha: staging.targetBaseSha,
        treeSha: await stagingGit.tree(),
      };
    }
    const commit = await stagingGit.checkpoint(
      `chore: prepare ${candidate.id}`,
      false,
    );
    if (commit.exitCode !== 0) {
      throw new Error(
        commit.stderr || commit.stdout || "Could not checkpoint replay.",
      );
    }
    const [preparedCommitSha, treeSha] = await Promise.all([
      stagingGit.head(),
      stagingGit.tree(),
    ]);
    if (
      (await stagingGit.parent(preparedCommitSha)) !== staging.targetBaseSha
    ) {
      throw new Error(
        "Prepared replay commit does not descend directly from target.",
      );
    }
    await assertTargetUnchanged(this.options.git, target);
    return { ...staging, preparedCommitSha, treeSha };
  }
}

async function targetSnapshot(git: GitClient): Promise<{
  head: string;
  branch: string;
  identity: string;
  tree: string;
  operation?: string;
  clean: boolean;
}> {
  const [head, branch, identity, tree, operation, clean] = await Promise.all([
    git.head(),
    git.currentBranch(),
    git.checkoutIdentity(),
    git.tree(),
    git.activeOperation(),
    git.isClean(),
  ]);
  if (operation || !clean) {
    throw new Error(
      "Target checkout is not clean and idle for replay preparation.",
    );
  }
  return { head, branch, identity, tree, operation, clean };
}

async function assertTargetUnchanged(
  git: GitClient,
  expected: Awaited<ReturnType<typeof targetSnapshot>>,
): Promise<void> {
  const actual = await targetSnapshot(git);
  if (
    actual.head !== expected.head ||
    actual.branch !== expected.branch ||
    actual.identity !== expected.identity ||
    actual.tree !== expected.tree
  ) {
    throw new Error("Target checkout changed during replay preparation.");
  }
}

const changedPaths = changedPathsBetween;

function intersection(left: string[], right: string[]): string[] {
  const values = new Set(right);
  return left.filter((path) => values.has(path));
}

function patchHash(patch: string): string {
  return sha256(normalizePatch(patch));
}

function normalizePatch(patch: string): string {
  return patch.replace(/index [0-9a-f]+\.{2}[0-9a-f]+/g, "index").trim();
}
