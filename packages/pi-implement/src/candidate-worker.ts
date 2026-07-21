import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { CandidateRef } from "./canonical-state.js";
import type { GitClient } from "./git.js";
import type { TaskJson } from "./state.js";

export type TaskWorkspace = {
  taskId: string;
  branchName: string;
  worktreePath: string;
  baseSha: string;
};

export class TaskWorkspaceManager {
  constructor(
    private readonly git: GitClient,
    private readonly worktreesRoot: string,
  ) {}

  async ensure(
    workspace: TaskWorkspace,
    options: { existingBranch?: boolean; expectedHead?: string } = {},
  ): Promise<{ created: boolean }> {
    this.assertOwnedPath(workspace.worktreePath);
    const worktrees = await this.git.listWorktrees();
    const expectedPath = await canonicalPath(workspace.worktreePath);
    if (
      (await Promise.all(worktrees.map(canonicalPath))).includes(expectedPath)
    ) {
      await this.assertOwnedWorkspace(workspace);
      return { created: false };
    }

    const createdBranch = !options.existingBranch;
    if (createdBranch) {
      await this.git.createTaskBranch(workspace.branchName, workspace.baseSha);
    }
    try {
      await this.git.addWorktree(workspace.worktreePath, workspace.branchName);
      await this.assertOwnedWorkspace(workspace, false);
      return { created: true };
    } catch (error) {
      try {
        await this.git.removeWorktree(workspace.worktreePath);
      } catch {
        // A failed add may not have registered a worktree.
      }
      if (createdBranch) {
        await this.git.deleteTaskBranch(workspace.branchName);
      }
      throw error;
    }
  }

  async remove(
    workspace: TaskWorkspace,
    expectedHead: string = workspace.baseSha,
  ): Promise<void> {
    this.assertOwnedPath(workspace.worktreePath);
    await this.assertOwnedWorkspace(workspace);
    const taskGit = this.git.forWorktree(workspace.worktreePath);
    if (
      (await taskGit.head()) !== expectedHead ||
      !(await taskGit.isClean()) ||
      !(await taskGit.isAncestor(workspace.baseSha, expectedHead))
    ) {
      throw new Error(
        `Task workspace has unrecorded work or an unexpected commit: ${workspace.worktreePath}`,
      );
    }
    await this.git.removeWorktree(workspace.worktreePath);
    await this.git.deleteTaskBranch(workspace.branchName);
  }

  private assertOwnedPath(worktreePath: string): void {
    const root = resolve(this.worktreesRoot);
    const candidate = resolve(worktreePath);
    const path = relative(root, candidate);
    if (!path || path.startsWith("..") || path.includes("../")) {
      throw new Error(
        `Task workspace is outside the owned worktree root: ${worktreePath}`,
      );
    }
  }

  private async assertOwnedWorkspace(
    workspace: Pick<TaskWorkspace, "branchName" | "worktreePath">,
    verifyRegistration = true,
  ): Promise<void> {
    if (verifyRegistration) {
      const worktrees = await this.git.listWorktrees();
      const expectedPath = await canonicalPath(workspace.worktreePath);
      const registered = await Promise.all(worktrees.map(canonicalPath));
      if (!registered.includes(expectedPath)) {
        throw new Error(
          `Task workspace is not registered: ${workspace.worktreePath}`,
        );
      }
    }
    const taskGit = this.git.forWorktree(workspace.worktreePath);
    if ((await taskGit.currentBranch()) !== workspace.branchName) {
      throw new Error(
        `Task workspace branch does not match owned branch: ${workspace.worktreePath}`,
      );
    }
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export async function approvedCandidateRef(args: {
  taskId: string;
  git: GitClient;
  sourceBaseSha: string;
  baseSha: string;
  branchName: string;
  worktreePath: string;
  review: TaskJson["review"] | undefined;
  artifactRefs: string[];
  protectedPaths: string[];
  assessedAt: string;
}): Promise<CandidateRef> {
  const {
    taskId,
    git,
    sourceBaseSha,
    baseSha,
    branchName,
    worktreePath,
    review,
    artifactRefs,
    protectedPaths,
    assessedAt,
  } = args;
  const commitSha = await git.head();
  const [treeSha, branch, clean, isDescendant] = await Promise.all([
    git.tree(),
    git.currentBranch(),
    git.isCleanExcept(protectedPaths),
    git.isAncestor(baseSha, commitSha),
  ]);
  if (branch !== branchName) {
    throw new Error(
      `Approved candidate is on ${branch}, not owned branch ${branchName}`,
    );
  }
  if (!clean) {
    throw new Error("Approved candidate worktree is dirty");
  }
  if (!isDescendant) {
    throw new Error(
      `Candidate ${commitSha} does not descend from base ${baseSha}`,
    );
  }
  if ((await git.treeAt(commitSha)) !== treeSha) {
    throw new Error(
      `Approved candidate ${commitSha} tree does not match its worktree`,
    );
  }

  const convergence = review?.convergence?.state;
  if (review?.lastDecision !== "reviewed" || !convergence) {
    throw new Error("Approved candidate is missing typed review convergence");
  }
  if (convergence.outstandingIds.length > 0) {
    throw new Error("Approved candidate has unresolved review findings");
  }

  const id = `candidate:${taskId}:${commitSha}`;
  return {
    id,
    sourceBaseSha,
    baseSha,
    commitSha,
    treeSha,
    branchName,
    worktreePath,
    reviewReceipt: {
      id: `review:${id}`,
      candidateId: id,
      candidateCommitSha: commitSha,
      candidateTreeSha: treeSha,
      verdict: "approved",
      convergence: {
        round: convergence.round,
        outstandingFindingIds: convergence.outstandingIds,
        bestOutstandingCount: convergence.bestOutstandingCount,
        evidenceRefs: artifactRefs,
      },
      assessedAt,
    },
  };
}
