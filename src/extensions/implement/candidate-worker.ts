import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { GitClient } from "./git.js";

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
      await this.assertOwnedWorkspace(workspace, true, options.expectedHead);
      return { created: false };
    }

    const createdBranch = !options.existingBranch;
    if (createdBranch) {
      await this.git.createTaskBranch(workspace.branchName, workspace.baseSha);
    }
    try {
      await this.git.addWorktree(workspace.worktreePath, workspace.branchName);
      await this.assertOwnedWorkspace(workspace, false, options.expectedHead);
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

  async discard(
    workspace: Pick<TaskWorkspace, "branchName" | "worktreePath">,
  ): Promise<void> {
    this.assertOwnedPath(workspace.worktreePath);
    const worktrees = await this.git.listWorktrees();
    const expectedPath = await canonicalPath(workspace.worktreePath);
    if (
      (await Promise.all(worktrees.map(canonicalPath))).includes(expectedPath)
    ) {
      await this.assertOwnedWorkspace(workspace);
      await this.git.removeWorktree(workspace.worktreePath);
    }
    if (
      (await this.git.listBranchesMatching(workspace.branchName)).includes(
        workspace.branchName,
      )
    ) {
      await this.git.deleteTaskBranch(workspace.branchName);
    }
  }

  async recreate(workspace: TaskWorkspace, checkpoint: string): Promise<void> {
    this.assertOwnedPath(workspace.worktreePath);
    await this.assertOwnedWorkspace(workspace);
    const workspaceGit = this.git.forWorktree(workspace.worktreePath);
    if (
      !(await this.git.isAncestor(workspace.baseSha, checkpoint)) ||
      !(await workspaceGit.isAncestor(checkpoint, await workspaceGit.head()))
    ) {
      throw new Error(
        `Task workspace cannot be recreated from an untrusted checkpoint: ${workspace.worktreePath}`,
      );
    }
    await this.git.removeWorktree(workspace.worktreePath);
    await this.ensure(workspace, { existingBranch: true });
    const recreatedGit = this.git.forWorktree(workspace.worktreePath);
    await recreatedGit.resetHard(checkpoint);
    if ((await recreatedGit.head()) !== checkpoint) {
      throw new Error(
        `Task workspace was not recreated at its trusted checkpoint: ${workspace.worktreePath}`,
      );
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
    expectedHead?: string,
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
    if (expectedHead && (await taskGit.head()) !== expectedHead) {
      throw new Error(
        `Task workspace does not match its expected checkpoint: ${workspace.worktreePath}`,
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
