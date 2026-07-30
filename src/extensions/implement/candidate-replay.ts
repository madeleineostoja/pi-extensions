import { resolve } from "node:path";
import { TaskWorkspaceManager } from "./candidate-worker.js";
import { sha256 } from "./source-integrity.js";
import {
  changedPathsBetween,
  type CommandResult,
  type GitClient,
} from "./git.js";
import {
  boundedFailureOutput,
  type FailureCommandEvidence,
} from "./failure-policy.js";

export type ReplayCandidate = {
  id: string;
  baseSha: string;
  integrationBaseSha?: string;
  commitSha: string;
  treeSha: string;
};

export type ReplayStaging = {
  id: string;
  operationId: string;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  targetRef: string;
  preparedCommitSha?: string;
  treeSha?: string;
  candidateId: string;
  candidateCommitSha: string;
  candidateTreeSha: string;
  replayPatch?: string;
  replayPatchHash?: string;
  candidatePaths: string[];
  targetPaths: string[];
  replayPaths?: string[];
  hookCommand?: FailureCommandEvidence;
};

export type ReplayPreparationDisposition =
  | "same_base"
  | "reconciled_same_base"
  | "clean_non_overlap";

export type PublicationPreparation = {
  id: string;
  operationId: string;
  candidateId: string;
  candidateCommitSha: string;
  candidateTreeSha: string;
  targetBaseSha: string;
  targetRef: string;
  preparedCommitSha: string;
  preparedTreeSha: string;
  stagingWorktree: string;
  stagingBranch: string;
  replayPatchHash: string;
  changedPaths: string[];
  disposition: ReplayPreparationDisposition;
  hookEvidence: string;
  hookCommand: FailureCommandEvidence;
};

export function stagingIdentity(args: {
  runId: string;
  operationId: string;
  candidateId: string;
  candidateCommitSha: string;
  candidateTreeSha: string;
  targetBaseSha: string;
  targetRef: string;
}): { id: string; branchName: string } {
  const id = `staging-${sha256(
    `${args.runId}\0${args.operationId}\0${args.candidateId}\0${args.candidateCommitSha}\0${args.candidateTreeSha}\0${args.targetBaseSha}\0${args.targetRef}`,
  )}`;
  return { id, branchName: `pipkin/implement/${args.runId}/${id}` };
}

export function publicationPreparationId(args: {
  runId: string;
  preparation: Omit<PublicationPreparation, "id">;
}): string {
  const preparation = args.preparation;
  return `preparation-${sha256(
    JSON.stringify({
      runId: args.runId,
      operationId: preparation.operationId,
      candidateId: preparation.candidateId,
      candidateCommitSha: preparation.candidateCommitSha,
      candidateTreeSha: preparation.candidateTreeSha,
      targetBaseSha: preparation.targetBaseSha,
      targetRef: preparation.targetRef,
      stagingWorktree: preparation.stagingWorktree,
      stagingBranch: preparation.stagingBranch,
      replayPatchHash: preparation.replayPatchHash,
      changedPaths: preparation.changedPaths,
      disposition: preparation.disposition,
      hookEvidence: preparation.hookEvidence,
      hookCommand: preparation.hookCommand,
    }),
  )}`;
}

export function publicationIntentId(args: {
  runId: string;
  operationId: string;
  preparation: PublicationPreparation;
}): string {
  return `publication-${sha256(
    `${args.runId}\0${args.operationId}\0${args.preparation.id}\0${args.preparation.candidateId}\0${args.preparation.candidateCommitSha}\0${args.preparation.candidateTreeSha}\0${args.preparation.targetBaseSha}\0${args.preparation.targetRef}\0${args.preparation.preparedCommitSha}\0${args.preparation.preparedTreeSha}`,
  )}`;
}

export type CandidateReplayOutcome =
  | {
      kind: "prepared";
      disposition: ReplayPreparationDisposition;
      staging: ReplayStaging & { preparedCommitSha: string; treeSha: string };
    }
  | {
      kind: "reconciliation_required";
      disposition: "overlap" | "conflict" | "changed_patch";
      staging: ReplayStaging;
      evidence: string;
      hookMutated?: boolean;
    }
  | {
      kind: "hook_rejected";
      staging: ReplayStaging;
      evidence: string;
      command: FailureCommandEvidence;
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

export function publicationPreparation(
  args: {
    runId: string;
    operationId: string;
    candidate: ReplayCandidate;
    disposition: ReplayPreparationDisposition;
    targetRef: string;
    hookEvidence: string;
    hookCommand: FailureCommandEvidence;
  },
  prepared: Extract<CandidateReplayOutcome, { kind: "prepared" }>["staging"],
): PublicationPreparation {
  const replayPatchHash = prepared.replayPatchHash;
  if (!replayPatchHash) {
    throw new Error("Prepared replay is missing its immutable patch identity.");
  }
  if (
    prepared.operationId !== args.operationId ||
    prepared.targetRef !== args.targetRef ||
    prepared.candidateId !== args.candidate.id ||
    prepared.candidateCommitSha !== args.candidate.commitSha ||
    prepared.candidateTreeSha !== args.candidate.treeSha
  ) {
    throw new Error(
      "Prepared replay does not match its immutable operation identity.",
    );
  }
  const preparation = {
    operationId: args.operationId,
    candidateId: args.candidate.id,
    candidateCommitSha: args.candidate.commitSha,
    candidateTreeSha: args.candidate.treeSha,
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
    hookCommand: args.hookCommand,
  } satisfies Omit<PublicationPreparation, "id">;
  return {
    id: publicationPreparationId({ runId: args.runId, preparation }),
    ...preparation,
  };
}

export type CandidateReplayOptions = {
  git: GitClient;
  worktreesRoot: string;
  runId: string;
  operationId: string;
  protectedPaths?: string[];
  protectedArtifactsMatch?: () => boolean | Promise<boolean>;
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
    publicationCommitSubject?: string,
    signal?: AbortSignal,
    retainedPreparation?: PublicationPreparation,
  ): Promise<CandidateReplayOutcome> {
    if (signal?.aborted) {
      return { kind: "cancelled" };
    }
    let retainedStaging: ReplayStaging | undefined;
    try {
      const git = this.options.git.withSignal?.(signal) ?? this.options.git;
      const target = await targetSnapshot(git, this.options);
      const replayBaseSha = candidate.integrationBaseSha ?? candidate.baseSha;
      if ((await git.treeAt(candidate.commitSha)) !== candidate.treeSha) {
        throw new Error(
          "Candidate tree no longer matches its reviewed identity.",
        );
      }
      if (!(await git.isAncestor(candidate.baseSha, candidate.commitSha))) {
        throw new Error(
          "Candidate no longer descends from its historical workstream base.",
        );
      }
      if (!(await git.isAncestor(replayBaseSha, candidate.commitSha))) {
        throw new Error(
          "Candidate no longer descends from its reviewed integration base.",
        );
      }
      if (!(await git.isAncestor(replayBaseSha, target.head))) {
        throw new Error(
          "Current target no longer descends from the reviewed replay base.",
        );
      }
      const [candidatePaths, targetPaths, candidatePatch] = await Promise.all([
        changedPaths(this.options.git, replayBaseSha, candidate.commitSha),
        replayBaseSha === target.head
          ? Promise.resolve([])
          : changedPaths(this.options.git, replayBaseSha, target.head),
        git.diffRange(replayBaseSha, candidate.commitSha),
      ]);
      const staging = await this.ensureStaging(
        target.head,
        target.ref,
        candidate,
        candidatePaths,
        targetPaths,
        patchHash(candidatePatch),
        retainedPreparation,
      );
      retainedStaging = staging;
      if (staging.preparedCommitSha && staging.treeSha) {
        await assertTargetUnchanged(git, target, this.options);
        return {
          kind: "prepared",
          disposition: replayDisposition(candidate, target.head),
          staging: staging as ReplayStaging & {
            preparedCommitSha: string;
            treeSha: string;
          },
        };
      }
      if (candidate.commitSha === replayBaseSha) {
        await assertTargetUnchanged(git, target, this.options);
        if (replayBaseSha !== target.head) {
          return {
            kind: "repository_assessment_required",
            staging,
            evidence:
              "The reviewed already-satisfied candidate has a stale repository base.",
          };
        }
        const committed = await this.commitPrepared(
          staging,
          candidate,
          replayBaseSha,
          target,
          publicationCommitSubject,
        );
        return committed.kind === "prepared"
          ? {
              kind: "prepared",
              disposition: replayDisposition(candidate, target.head),
              staging: committed.staging,
            }
          : committed;
      }

      const overlaps = intersection(candidatePaths, targetPaths);
      const workspaceGit = git.forWorktree(staging.worktreePath);
      const patch = candidatePatch;
      const applied = await workspaceGit.applyPatch(patch);
      if (signal?.aborted) {
        await assertTargetUnchanged(git, target, this.options);
        return { kind: "cancelled", staging };
      }
      if (applied.exitCode !== 0) {
        await assertTargetUnchanged(git, target, this.options);
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
        await assertTargetUnchanged(git, target, this.options);
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
        await assertTargetUnchanged(git, target, this.options);
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
      const committed = await this.commitPrepared(
        {
          ...staging,
          replayPaths,
          replayPatch: patch,
          replayPatchHash: patchHash(patch),
        },
        candidate,
        replayBaseSha,
        target,
        publicationCommitSubject,
      );
      if (committed.kind !== "prepared") {
        return committed;
      }
      return {
        kind: "prepared",
        disposition: replayDisposition(candidate, target.head),
        staging: committed.staging,
      };
    } catch (error) {
      return {
        kind: "infrastructure_failure",
        evidence: error instanceof Error ? error.message : String(error),
        ...(retainedStaging ? { staging: retainedStaging } : {}),
      };
    }
  }

  private async ensureStaging(
    targetBaseSha: string,
    targetRef: string,
    candidate: ReplayCandidate,
    candidatePaths: string[],
    targetPaths: string[],
    candidatePatchHash: string,
    retainedPreparation?: PublicationPreparation,
  ): Promise<ReplayStaging> {
    const { id, branchName } = stagingIdentity({
      runId: this.options.runId,
      operationId: this.options.operationId,
      candidateId: candidate.id,
      candidateCommitSha: candidate.commitSha,
      candidateTreeSha: candidate.treeSha,
      targetBaseSha,
      targetRef,
    });
    const worktreePath = resolve(this.options.worktreesRoot, id);
    const workspace = {
      taskId: id,
      branchName,
      worktreePath,
      baseSha: targetBaseSha,
    };
    if (!retainedPreparation) {
      await this.workspaces.discard(workspace);
    }
    const existingBranch = (
      await this.options.git.listBranchesMatching(branchName)
    ).includes(branchName);
    await this.workspaces.ensure(workspace, { existingBranch });
    const stagingGit = this.options.git.forWorktree(worktreePath);
    await stagingGit.abortActiveOperation();
    if (retainedPreparation) {
      if (
        retainedPreparation.id !==
          publicationPreparationId({
            runId: this.options.runId,
            preparation: retainedPreparation,
          }) ||
        retainedPreparation.operationId !== this.options.operationId ||
        retainedPreparation.candidateId !== candidate.id ||
        retainedPreparation.candidateCommitSha !== candidate.commitSha ||
        retainedPreparation.candidateTreeSha !== candidate.treeSha ||
        retainedPreparation.targetBaseSha !== targetBaseSha ||
        retainedPreparation.targetRef !== targetRef ||
        retainedPreparation.stagingWorktree !== worktreePath ||
        retainedPreparation.stagingBranch !== branchName
      ) {
        throw new Error(
          "Retained preparation does not match its staging identity.",
        );
      }
      const [parent, tree, patch, replayPaths] = await Promise.all([
        stagingGit.parent(retainedPreparation.preparedCommitSha),
        stagingGit.treeAt(retainedPreparation.preparedCommitSha),
        stagingGit.diffRange(
          retainedPreparation.targetBaseSha,
          retainedPreparation.preparedCommitSha,
        ),
        changedPathsBetween(
          stagingGit,
          retainedPreparation.targetBaseSha,
          retainedPreparation.preparedCommitSha,
        ),
      ]);
      if (
        parent !== retainedPreparation.targetBaseSha ||
        tree !== retainedPreparation.preparedTreeSha ||
        patchHash(patch) !== retainedPreparation.replayPatchHash ||
        patchHash(patch) !== candidatePatchHash ||
        !samePaths(replayPaths, retainedPreparation.changedPaths)
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
        operationId: this.options.operationId,
        worktreePath,
        branchName,
        targetBaseSha,
        targetRef,
        candidateId: candidate.id,
        candidateCommitSha: candidate.commitSha,
        candidateTreeSha: candidate.treeSha,
        replayPatch: patch,
        replayPatchHash: patchHash(patch),
        candidatePaths,
        targetPaths,
        replayPaths: [...retainedPreparation.changedPaths],
        preparedCommitSha: retainedPreparation.preparedCommitSha,
        treeSha: retainedPreparation.preparedTreeSha,
        hookCommand: retainedPreparation.hookCommand,
      };
    }
    if ((await stagingGit.head()) !== targetBaseSha) {
      await stagingGit.resetHard(targetBaseSha);
    }
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
      operationId: this.options.operationId,
      worktreePath,
      branchName,
      targetBaseSha,
      targetRef,
      candidateId: candidate.id,
      candidateCommitSha: candidate.commitSha,
      candidateTreeSha: candidate.treeSha,
      candidatePaths,
      targetPaths,
    };
  }

  private async commitPrepared(
    staging: ReplayStaging,
    candidate: ReplayCandidate,
    replayBaseSha: string,
    target: Awaited<ReturnType<typeof targetSnapshot>>,
    publicationCommitSubject?: string,
  ): Promise<
    | {
        kind: "prepared";
        staging: ReplayStaging & { preparedCommitSha: string; treeSha: string };
      }
    | Extract<CandidateReplayOutcome, { kind: "hook_rejected" }>
    | Extract<CandidateReplayOutcome, { kind: "reconciliation_required" }>
  > {
    const stagingGit = this.options.git.forWorktree(staging.worktreePath);
    if (!(await stagingGit.hasStagedChanges())) {
      if (candidate.commitSha !== replayBaseSha) {
        throw new Error("Candidate replay unexpectedly has no staged changes.");
      }
      await assertTargetUnchanged(this.options.git, target, this.options);
      return {
        kind: "prepared",
        staging: {
          ...staging,
          replayPatch: "",
          replayPatchHash: patchHash(""),
          replayPaths: [],
          preparedCommitSha: staging.targetBaseSha,
          treeSha: await stagingGit.treeAt(staging.targetBaseSha),
        },
      };
    }
    if (!publicationCommitSubject) {
      throw new Error(
        "Publishable replay has no reviewer-authored commit subject.",
      );
    }
    const commit = await stagingGit.checkpoint(publicationCommitSubject, false);
    const command = hookCommandEvidence(commit, staging.worktreePath);
    if (commit.exitCode !== 0) {
      const [replayPatch, replayPaths, treeSha] = await Promise.all([
        stagingGit.stagedDiff(),
        stagingGit.stagedNameStatus().then((output) =>
          output
            .split("\n")
            .flatMap((line) => line.split("\t").slice(1))
            .filter(Boolean)
            .sort(),
        ),
        stagingGit.tree(),
      ]);
      await assertTargetUnchanged(this.options.git, target, this.options);
      return {
        kind: "hook_rejected",
        staging: {
          ...staging,
          replayPatch,
          replayPatchHash: patchHash(replayPatch),
          replayPaths,
          treeSha,
        },
        evidence: command.output || "The ordinary staging commit was rejected.",
        command,
      };
    }
    const preparedCommitSha = await stagingGit.head();
    const [treeSha, branch, clean] = await Promise.all([
      stagingGit.treeAt(preparedCommitSha),
      stagingGit.currentBranch(),
      stagingGit.isClean(),
    ]);
    if (
      (await stagingGit.parent(preparedCommitSha)) !== staging.targetBaseSha ||
      branch !== staging.branchName ||
      !clean
    ) {
      throw new Error(
        "Prepared staging state does not match its durable identity.",
      );
    }
    const [actualPatch, actualPaths] = await Promise.all([
      stagingGit.diffRange(staging.targetBaseSha, preparedCommitSha),
      changedPathsBetween(stagingGit, staging.targetBaseSha, preparedCommitSha),
    ]);
    await assertTargetUnchanged(this.options.git, target, this.options);
    if (
      patchHash(actualPatch) !== staging.replayPatchHash ||
      JSON.stringify(actualPaths) !== JSON.stringify(staging.replayPaths)
    ) {
      return {
        kind: "reconciliation_required",
        disposition: "changed_patch",
        staging: {
          ...staging,
          preparedCommitSha,
          treeSha,
          replayPatch: actualPatch,
          replayPatchHash: patchHash(actualPatch),
          replayPaths: actualPaths,
          hookCommand: command,
        },
        evidence:
          "A repository hook changed the prepared replay; the changed delta requires review.",
        hookMutated: true,
      };
    }
    return {
      kind: "prepared",
      staging: { ...staging, preparedCommitSha, treeSha, hookCommand: command },
    };
  }
}

function hookCommandEvidence(
  command: CommandResult,
  cwd: string,
): FailureCommandEvidence {
  return {
    command: command.command,
    cwd,
    exitCode: command.exitCode,
    ...(command.signal ? { signal: command.signal } : {}),
    timedOut: command.timedOut === true,
    output: boundedFailureOutput(
      [command.stdout, command.stderr].filter(Boolean).join("\n"),
    ),
  };
}

async function targetSnapshot(
  git: GitClient,
  options: CandidateReplayOptions,
): Promise<{
  head: string;
  branch: string;
  ref: string;
  identity: string;
  tree: string;
  operation?: string;
  clean: boolean;
}> {
  const protectedPaths = options.protectedPaths ?? [];
  if (protectedPaths.length > 0 && !options.protectedArtifactsMatch) {
    throw new Error(
      "Replay protection requires exact retained hashes for sanctioned artifacts.",
    );
  }
  const [
    head,
    branch,
    identity,
    tree,
    operation,
    clean,
    protectedIndexDirty,
    protectedMatch,
  ] = await Promise.all([
    git.head(),
    git.currentBranch(),
    git.checkoutIdentity(),
    git.tree(),
    git.activeOperation(),
    git.isCleanExcept([...protectedPaths, options.worktreesRoot]),
    git.hasStagedChangesInPaths(protectedPaths),
    options.protectedArtifactsMatch?.() ?? true,
  ]);
  if (operation || !clean || protectedIndexDirty || !protectedMatch) {
    throw new Error(
      "Target checkout is not clean outside sanctioned artifacts and exact protected content for replay preparation.",
    );
  }
  return {
    head,
    branch,
    ref: `refs/heads/${branch}`,
    identity,
    tree,
    operation,
    clean,
  };
}

async function assertTargetUnchanged(
  git: GitClient,
  expected: Awaited<ReturnType<typeof targetSnapshot>>,
  options: CandidateReplayOptions,
): Promise<void> {
  const actual = await targetSnapshot(git, options);
  if (
    actual.head !== expected.head ||
    actual.branch !== expected.branch ||
    actual.ref !== expected.ref ||
    actual.identity !== expected.identity ||
    actual.tree !== expected.tree
  ) {
    throw new Error("Target checkout changed during replay preparation.");
  }
}

const changedPaths = changedPathsBetween;

function replayDisposition(
  candidate: ReplayCandidate,
  targetBaseSha: string,
): ReplayPreparationDisposition {
  const replayBaseSha = candidate.integrationBaseSha ?? candidate.baseSha;
  if (targetBaseSha !== replayBaseSha) {
    return "clean_non_overlap";
  }
  return candidate.integrationBaseSha ? "reconciled_same_base" : "same_base";
}

function intersection(left: string[], right: string[]): string[] {
  const values = new Set(right);
  return left.filter((path) => values.has(path));
}

function samePaths(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  );
}

function patchHash(patch: string): string {
  return sha256(normalizePatch(patch));
}

function normalizePatch(patch: string): string {
  return patch.replace(/index [0-9a-f]+\.{2}[0-9a-f]+/g, "index").trim();
}
