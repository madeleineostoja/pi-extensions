import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { CandidateRef, CanonicalRunState } from "./canonical-state.js";
import { TaskWorkspaceManager } from "./candidate-worker.js";
import type { GitClient } from "./git.js";

export type IntegrationAttempt =
  CanonicalRunState["integrationAttempts"][number];

export type IntegrationValidation = (args: {
  git: GitClient;
  worktreePath: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; reason?: string }>;

export type IntegrationEngineOptions = {
  git: GitClient;
  worktreesRoot: string;
  targetCheckoutId: string;
  targetBranch: string;
  protectedPaths: string[];
  validate?: IntegrationValidation;
};

export type PreparedIntegration = {
  attemptId: string;
  worktreePath: string;
  branchName: string;
  targetBaseSha: string;
  preparedCommitSha: string;
  treeSha: string;
};

export type IntegrationOutcome =
  | { kind: "prepared"; prepared: PreparedIntegration }
  | { kind: "reconstructed"; prepared: PreparedIntegration }
  | { kind: "landed"; receipt: CanonicalRunState["landingReceipts"][number] }
  | { kind: "target_moved"; expected: string; actual: string }
  | { kind: "needs_rework"; reason: string }
  | { kind: "retryable_infrastructure"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "cancelled" };

function safeGitRefPart(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "-");
}

export class IntegrationEngine {
  private readonly workspaceManager: TaskWorkspaceManager;

  constructor(private readonly options: IntegrationEngineOptions) {
    this.workspaceManager = new TaskWorkspaceManager(
      options.git,
      options.worktreesRoot,
    );
  }

  async prepare(
    attempt: IntegrationAttempt,
    candidate: CandidateRef,
    signal?: AbortSignal,
  ): Promise<IntegrationOutcome> {
    if (signal?.aborted) {
      return { kind: "cancelled" };
    }
    const targetHead = await this.options.git.head();
    if (
      candidate.baseSha !== targetHead ||
      attempt.targetBaseSha !== targetHead
    ) {
      return {
        kind: "target_moved",
        expected: candidate.baseSha,
        actual: targetHead,
      };
    }

    const worktreePath = resolve(this.options.worktreesRoot, attempt.id);
    const branchName = `pi-implement/integration/${safeGitRefPart(attempt.id)}`;
    try {
      const existingBranch = (
        await this.options.git.listBranchesMatching(branchName)
      )
        .map((branch) => branch.replace(/^\*\s*/, ""))
        .includes(branchName);
      await this.workspaceManager.ensure(
        {
          taskId: attempt.id,
          branchName,
          worktreePath,
          baseSha: targetHead,
        },
        { existingBranch },
      );
      const stagingGit = this.options.git.forWorktree(worktreePath);
      if ((await stagingGit.head()) !== targetHead) {
        return {
          kind: "blocked",
          reason: `Integration workspace ${worktreePath} is not at expected target HEAD.`,
        };
      }
      const patch = await this.options.git.diffRange(
        candidate.baseSha,
        candidate.commitSha,
      );
      const applied = await stagingGit.applyPatch(patch);
      if (applied.exitCode !== 0) {
        return {
          kind: "needs_rework",
          reason:
            applied.stderr ||
            applied.stdout ||
            "Candidate delta could not be applied.",
        };
      }
      if ((await stagingGit.tree()) !== candidate.treeSha) {
        return {
          kind: "blocked",
          reason:
            "Applied candidate tree does not match the approved candidate.",
        };
      }
      const validation = await this.options.validate?.({
        git: stagingGit,
        worktreePath,
        signal,
      });
      if (signal?.aborted) {
        return { kind: "cancelled" };
      }
      if (validation && !validation.ok) {
        return {
          kind: "needs_rework",
          reason: validation.reason ?? "Integration validation failed.",
        };
      }
      if ((await stagingGit.tree()) !== candidate.treeSha) {
        return {
          kind: "needs_rework",
          reason:
            "Integration validation modified the staged candidate workspace.",
        };
      }
      const committed = await stagingGit.checkpoint(
        attempt.owner.kind === "task"
          ? `chore: integrate ${attempt.owner.taskId}`
          : "chore: integrate overall review",
        false,
      );
      if (committed.exitCode !== 0) {
        return {
          kind: "needs_rework",
          reason:
            committed.stderr ||
            committed.stdout ||
            "Could not prepare integration commit.",
        };
      }
      const checkpointSha = await stagingGit.head();
      const hooks = await stagingGit.runCheckpointHooks(checkpointSha);
      if (hooks.exitCode !== 0) {
        return {
          kind: "needs_rework",
          reason:
            hooks.stderr || hooks.stdout || "Integration approval hook failed.",
        };
      }
      const preparedCommitSha = await stagingGit.head();
      const [parent, treeSha] = await Promise.all([
        stagingGit.parent(preparedCommitSha),
        stagingGit.treeAt(preparedCommitSha),
      ]);
      if (parent !== targetHead || treeSha !== candidate.treeSha) {
        return {
          kind: "blocked",
          reason:
            "Prepared integration commit does not preserve its target parent and candidate tree.",
        };
      }
      return {
        kind: "prepared",
        prepared: {
          attemptId: attempt.id,
          worktreePath,
          branchName,
          targetBaseSha: targetHead,
          preparedCommitSha,
          treeSha,
        },
      };
    } catch (error) {
      return {
        kind: "retryable_infrastructure",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async reconstructPrepared(
    attempt: IntegrationAttempt,
    candidate: CandidateRef,
  ): Promise<IntegrationOutcome> {
    const preparedCommitSha =
      attempt.phase === "prepared" ||
      attempt.phase === "publishing" ||
      attempt.phase === "completed" ||
      (attempt.phase === "paused" && attempt.resumePhase !== "preparing")
        ? attempt.preparedCommitSha
        : undefined;
    if (!preparedCommitSha) {
      return {
        kind: "blocked",
        reason: "Integration attempt has no durable prepared commit.",
      };
    }
    try {
      const [parent, treeSha] = await Promise.all([
        this.options.git.parent(preparedCommitSha),
        this.options.git.treeAt(preparedCommitSha),
      ]);
      if (parent !== attempt.targetBaseSha || treeSha !== candidate.treeSha) {
        return {
          kind: "blocked",
          reason:
            "Prepared integration commit does not preserve its target parent and candidate tree.",
        };
      }
      return {
        kind: "reconstructed",
        prepared: {
          attemptId: attempt.id,
          worktreePath: resolve(this.options.worktreesRoot, attempt.id),
          branchName: `pi-implement/integration/${safeGitRefPart(attempt.id)}`,
          targetBaseSha: attempt.targetBaseSha,
          preparedCommitSha,
          treeSha,
        },
      };
    } catch (error) {
      return {
        kind: "retryable_infrastructure",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async publish(
    attempt: IntegrationAttempt,
    prepared: PreparedIntegration,
    candidate: CandidateRef,
    signal?: AbortSignal,
  ): Promise<IntegrationOutcome> {
    if (signal?.aborted) {
      return { kind: "cancelled" };
    }
    try {
      const protectedBefore = await this.protectedArtifactSnapshot();
      const [checkoutId, branch, head, operation, clean] = await Promise.all([
        this.options.git.checkoutIdentity(),
        this.options.git.currentBranch(),
        this.options.git.head(),
        this.options.git.activeOperation(),
        this.options.git.isCleanExcept(this.options.protectedPaths),
      ]);
      if (checkoutId !== this.options.targetCheckoutId) {
        return { kind: "blocked", reason: "Target checkout identity changed." };
      }
      if (branch !== this.options.targetBranch) {
        return { kind: "blocked", reason: "Target checkout branch changed." };
      }
      if (operation) {
        return {
          kind: "blocked",
          reason: `Target checkout has an active ${operation} operation.`,
        };
      }
      if (!clean) {
        return {
          kind: "blocked",
          reason: "Target checkout is dirty outside protected artifacts.",
        };
      }
      if (head === prepared.preparedCommitSha) {
        if ((await this.options.git.tree()) !== prepared.treeSha) {
          return {
            kind: "blocked",
            reason: "Published target tree does not match the prepared commit.",
          };
        }
        return {
          kind: "landed",
          receipt: this.landingReceipt(attempt, prepared, candidate),
        };
      }
      if (head !== prepared.targetBaseSha) {
        return {
          kind: "target_moved",
          expected: prepared.targetBaseSha,
          actual: head,
        };
      }
      if (
        (await this.options.git.parent(prepared.preparedCommitSha)) !== head
      ) {
        return {
          kind: "blocked",
          reason: "Prepared commit no longer fast-forwards the target.",
        };
      }
      const merged = await this.options.git.mergeFastForward(
        prepared.preparedCommitSha,
      );
      if (merged.exitCode !== 0) {
        const currentHead = await this.options.git.head();
        return currentHead === head
          ? {
              kind: "retryable_infrastructure",
              reason:
                merged.stderr ||
                merged.stdout ||
                "Fast-forward publication failed.",
            }
          : { kind: "target_moved", expected: head, actual: currentHead };
      }
      const [publishedHead, publishedTree, cleanAfter, protectedAfter] =
        await Promise.all([
          this.options.git.head(),
          this.options.git.tree(),
          this.options.git.isCleanExcept(this.options.protectedPaths),
          this.protectedArtifactSnapshot(),
        ]);
      if (
        publishedHead !== prepared.preparedCommitSha ||
        publishedTree !== prepared.treeSha ||
        !cleanAfter ||
        JSON.stringify(protectedBefore) !== JSON.stringify(protectedAfter)
      ) {
        return {
          kind: "blocked",
          reason:
            "Target post-publication checks could not prove a coherent landing.",
        };
      }
      return {
        kind: "landed",
        receipt: this.landingReceipt(attempt, prepared, candidate),
      };
    } catch (error) {
      return {
        kind: "retryable_infrastructure",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async cleanup(prepared: PreparedIntegration): Promise<void> {
    await this.workspaceManager.remove(
      {
        taskId: prepared.attemptId,
        branchName: prepared.branchName,
        worktreePath: prepared.worktreePath,
        baseSha: prepared.targetBaseSha,
      },
      prepared.preparedCommitSha,
    );
  }

  private landingReceipt(
    attempt: IntegrationAttempt,
    prepared: PreparedIntegration,
    candidate: CandidateRef,
  ): CanonicalRunState["landingReceipts"][number] {
    return {
      attemptId: attempt.id,
      owner: attempt.owner,
      candidateCommitSha: candidate.commitSha,
      targetCheckoutId: this.options.targetCheckoutId,
      targetRef: this.options.targetBranch,
      targetBaseSha: prepared.targetBaseSha,
      integrationCommitSha: prepared.preparedCommitSha,
      treeSha: prepared.treeSha,
      pipelineHash: attempt.pipelineHash,
      publishedAt: new Date().toISOString(),
    };
  }

  private async protectedArtifactSnapshot(): Promise<
    Record<string, string | undefined>
  > {
    const root = await this.options.git.root();
    const snapshots = await Promise.all(
      this.options.protectedPaths.map(async (path) => {
        const absolute = resolve(root, path);
        if (relative(root, absolute).startsWith("..")) {
          throw new Error(
            `Protected artifact is outside target checkout: ${path}`,
          );
        }
        try {
          return [path, await readFile(absolute, "utf-8")] as const;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [path, undefined] as const;
          }
          throw error;
        }
      }),
    );
    return Object.fromEntries(snapshots);
  }
}
