import { createHash, randomBytes } from "node:crypto";
import { ensureGitInfoExclude } from "@pi-extensions/lib";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { GitProcess, type ProcessFailureKind } from "./git-process.js";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  signal?: string;
  timedOut?: boolean;
  cancelled?: boolean;
  failureKind?: ProcessFailureKind;
  cause?: unknown;
};

export type GitClient = {
  root(): Promise<string>;
  mainRoot(): Promise<string>;
  checkoutIdentity(): Promise<string>;
  currentBranch(): Promise<string>;
  activeOperation(): Promise<string | undefined>;
  head(): Promise<string>;
  parent(commit: string): Promise<string>;
  tree(): Promise<string>;
  treeAt(commit: string): Promise<string>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  isAmendOf(before: string, after: string): Promise<boolean>;
  status(): Promise<string>;
  isClean(): Promise<boolean>;
  isCleanExcept(paths: string[]): Promise<boolean>;
  stageAllExcept(paths: string[]): Promise<void>;
  stagePaths(paths: string[]): Promise<void>;
  hasStagedChanges(): Promise<boolean>;
  stagedDiffStat(): Promise<string>;
  stagedNameStatus(): Promise<string>;
  stagedDiff(): Promise<string>;
  stagedDeltaFromPatch(
    previousPatch: string,
  ): Promise<{ diff: string; nameStatus: string }>;
  diffRangeNameStatus(baseSha: string, headSha: string): Promise<string>;
  stagedDiffExcept(paths: string[]): Promise<string>;
  workingDiff(): Promise<string>;
  workingDiffExcept(paths: string[]): Promise<string>;
  nonignoredUntracked(): Promise<string[]>;
  nonignoredUntrackedFingerprint(): Promise<string>;
  abortActiveOperation(): Promise<void>;
  restoreSnapshot(
    head: string,
    stagedPatch: string,
    workingPatch: string,
    protectedPaths: string[],
  ): Promise<void>;
  stagedFingerprint(): Promise<string>;
  worktreeFingerprintExcept(paths: string[]): Promise<string>;
  restoreWorktreeFromIndexExcept(paths: string[]): Promise<void>;
  restoreStagedPatch(patch: string, protectedPaths: string[]): Promise<void>;
  checkpoint(message: string, amend: boolean): Promise<CommandResult>;
  runCheckpointHooks(checkpoint: string): Promise<CommandResult>;
  rewordInternal(message: string): Promise<CommandResult>;
  commit(message: string): Promise<CommandResult>;
  reword(message: string): Promise<CommandResult>;
  mergeFastForward(commitSha: string): Promise<CommandResult>;
  reset(): Promise<void>;
  resetHard(commitSha: string): Promise<void>;
  aheadOfBase(branchName: string, baseSha: string): Promise<boolean>;
  cherryPickNoCommit(commitSha: string): Promise<CommandResult>;
  applyPatch(patch: string): Promise<CommandResult>;
  cherryPickAbort(): Promise<void>;
  createTaskBranch(branchName: string, baseSha: string): Promise<void>;
  addWorktree(worktreePath: string, branchName: string): Promise<void>;
  removeWorktree(worktreePath: string): Promise<void>;
  deleteTaskBranch(branchName: string): Promise<void>;
  diffRange(baseSha: string, headSha: string): Promise<string>;
  diffRangeExcept(
    baseSha: string,
    headSha: string,
    paths: string[],
  ): Promise<string>;
  listBranchesMatching(pattern: string): Promise<string[]>;
  listWorktrees(): Promise<string[]>;
  ensureInfoExclude(pattern: string): Promise<void>;
  forWorktree(worktreePath: string, mainRepoRoot?: string): GitClient;
  withSignal?(signal?: AbortSignal): GitClient;
  onIdle?(): Promise<void>;
};

export class ExecGitClient implements GitClient {
  private readonly process: GitProcess;

  constructor(
    private readonly cwd: string,
    private readonly mainRepoRoot?: string,
    private readonly signal?: AbortSignal,
  ) {
    this.process = new GitProcess(cwd);
  }

  async root(): Promise<string> {
    return (await this.run(["rev-parse", "--show-toplevel"])).stdout.trim();
  }

  // Resolves the main checkout even when called from a linked worktree, so
  // state pathing and cleanup never operate relative to a user-owned worktree.
  async mainRoot(): Promise<string> {
    const commonDir = (
      await this.run([
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).stdout.trim();
    return dirname(commonDir);
  }

  async checkoutIdentity(): Promise<string> {
    const gitDir = (
      await this.run(["rev-parse", "--path-format=absolute", "--git-dir"])
    ).stdout.trim();
    return realpathSync(gitDir);
  }

  async currentBranch(): Promise<string> {
    return (await this.run(["branch", "--show-current"])).stdout.trim();
  }

  async activeOperation(): Promise<string | undefined> {
    for (const [ref, label] of [
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["MERGE_HEAD", "merge"],
      ["REVERT_HEAD", "revert"],
      ["REBASE_HEAD", "rebase"],
    ] as const) {
      const result = await this.run(["rev-parse", "-q", "--verify", ref], true);
      if (result.exitCode === 0) {
        return label;
      }
    }
    for (const path of ["rebase-merge", "rebase-apply"]) {
      const gitPath = (
        await this.run(["rev-parse", "--git-path", path])
      ).stdout.trim();
      const resolvedPath = isAbsolute(gitPath)
        ? gitPath
        : join(this.cwd, gitPath);
      if (existsSync(resolvedPath)) {
        return "rebase";
      }
    }
    return undefined;
  }

  async head(): Promise<string> {
    return (await this.run(["rev-parse", "HEAD"])).stdout.trim();
  }

  async parent(commit: string): Promise<string> {
    return (await this.run(["rev-parse", `${commit}^`])).stdout.trim();
  }

  async tree(): Promise<string> {
    return (
      await this.run(["write-tree"], false, undefined, "checkout", "idempotent")
    ).stdout.trim();
  }

  async treeAt(commit: string): Promise<string> {
    return (await this.run(["rev-parse", `${commit}^{tree}`])).stdout.trim();
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (
      (
        await this.run(
          ["merge-base", "--is-ancestor", ancestor, descendant],
          true,
        )
      ).exitCode === 0
    );
  }

  async isAmendOf(before: string, after: string): Promise<boolean> {
    if (before === after) {
      return true;
    }
    const [
      beforeParents,
      afterParents,
      beforeTree,
      afterTree,
      beforeMessage,
      afterMessage,
    ] = await Promise.all([
      this.run(["show", "-s", "--format=%P", before], true),
      this.run(["show", "-s", "--format=%P", after], true),
      this.run(["rev-parse", `${before}^{tree}`], true),
      this.run(["rev-parse", `${after}^{tree}`], true),
      this.run(["show", "-s", "--format=%B", before], true),
      this.run(["show", "-s", "--format=%B", after], true),
    ]);
    return (
      beforeParents.exitCode === 0 &&
      afterParents.exitCode === 0 &&
      beforeTree.exitCode === 0 &&
      afterTree.exitCode === 0 &&
      beforeMessage.exitCode === 0 &&
      afterMessage.exitCode === 0 &&
      beforeParents.stdout.trim() === afterParents.stdout.trim() &&
      beforeTree.stdout.trim() === afterTree.stdout.trim() &&
      beforeMessage.stdout === afterMessage.stdout
    );
  }

  async status(): Promise<string> {
    return (await this.run(["status", "--porcelain"])).stdout;
  }

  async isClean(): Promise<boolean> {
    return isCleanStatus(await this.status());
  }

  async isCleanExcept(paths: string[]): Promise<boolean> {
    const excludes = await this.pathspecs(paths, true);
    const status = (
      await this.run(["status", "--porcelain", "--", ":/", ...excludes])
    ).stdout;
    return isCleanStatus(status);
  }

  async stageAllExcept(paths: string[]): Promise<void> {
    await this.run(["reset", "-q"]);
    const excluded = new Set(await this.repoRelativePaths(paths));
    const candidates = await this.changedPaths();
    const specs = candidates
      .filter((path) => !excluded.has(path))
      .map((path) => `:(top,literal)${path}`);
    if (specs.length) {
      await this.run(["add", "-A", "--", ...specs]);
    }
  }

  async stagePaths(paths: string[]): Promise<void> {
    const specs = (await this.repoRelativePaths(paths)).map(
      (path) => `:(top,literal)${path}`,
    );
    if (specs.length) {
      await this.run(["add", "-A", "--", ...specs]);
    }
  }

  async hasStagedChanges(): Promise<boolean> {
    const result = await this.run(
      ["diff", "--cached", "--quiet", "HEAD"],
      true,
    );
    if (result.exitCode === 0) {
      return false;
    }
    if (result.exitCode === 1) {
      return true;
    }
    throw new Error(
      `${result.command} failed: ${result.stderr || result.stdout}`,
    );
  }

  async stagedDiffStat(): Promise<string> {
    return (await this.run(["diff", "--cached", "--stat", "HEAD"])).stdout;
  }

  async stagedNameStatus(): Promise<string> {
    return (await this.run(["diff", "--cached", "--name-status", "HEAD"]))
      .stdout;
  }

  async unstagedNameStatus(): Promise<string> {
    return (await this.run(["diff", "--name-status"])).stdout;
  }

  async stagedDiff(): Promise<string> {
    return (await this.run(["diff", "--cached", "--binary", "HEAD"])).stdout;
  }

  async stagedDeltaFromPatch(
    previousPatch: string,
  ): Promise<{ diff: string; nameStatus: string }> {
    const tempIndex = join(
      tmpdir(),
      `pi-implement-index-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    try {
      await this.run(["read-tree", "HEAD"], false, {
        GIT_INDEX_FILE: tempIndex,
      });
      if (previousPatch.trim()) {
        const patchPath = `${tempIndex}.patch`;
        try {
          writeFileSync(patchPath, previousPatch, "utf-8");
          await this.run(
            ["apply", "--index", "--whitespace=nowarn", patchPath],
            false,
            { GIT_INDEX_FILE: tempIndex },
          );
        } finally {
          rmSync(patchPath, { force: true });
        }
      }
      const previousTree = (
        await this.run(["write-tree"], false, { GIT_INDEX_FILE: tempIndex })
      ).stdout.trim();
      const currentTree = (await this.run(["write-tree"])).stdout.trim();
      const [diff, nameStatus] = await Promise.all([
        this.run(["diff", "--binary", previousTree, currentTree]),
        this.run(["diff", "--name-status", previousTree, currentTree]),
      ]);
      return { diff: diff.stdout, nameStatus: nameStatus.stdout };
    } finally {
      rmSync(tempIndex, { force: true });
    }
  }

  async stagedDiffExcept(paths: string[]): Promise<string> {
    return (
      await this.run([
        "diff",
        "--cached",
        "--binary",
        "HEAD",
        "--",
        ...(await this.protectedPathspecs(paths)),
      ])
    ).stdout;
  }

  async workingDiff(): Promise<string> {
    return (await this.run(["diff", "--binary"])).stdout;
  }

  async workingDiffExcept(paths: string[]): Promise<string> {
    return (
      await this.run([
        "diff",
        "--binary",
        "--",
        ...(await this.protectedPathspecs(paths)),
      ])
    ).stdout;
  }

  async nonignoredUntracked(): Promise<string[]> {
    return (
      await this.run(["ls-files", "--others", "--exclude-standard", "-z"])
    ).stdout
      .split("\0")
      .filter(Boolean)
      .sort();
  }

  async nonignoredUntrackedFingerprint(): Promise<string> {
    const paths = await this.nonignoredUntracked();
    return createHash("sha256")
      .update(
        paths
          .map((path) => {
            const content = readFileSync(join(this.cwd, path));
            return `${path}\0${createHash("sha256").update(content).digest("hex")}`;
          })
          .join("\0"),
      )
      .digest("hex");
  }

  async stagedFingerprint(): Promise<string> {
    const tree = await this.run(["write-tree"]);
    const nameStatus = await this.stagedNameStatus();
    const diff = await this.stagedDiff();
    return createHash("sha256")
      .update(tree.stdout.trim())
      .update("\0")
      .update(nameStatus)
      .update("\0")
      .update(diff)
      .digest("hex");
  }

  async worktreeFingerprintExcept(paths: string[]): Promise<string> {
    const pathspecs = await this.protectedPathspecs(paths);
    const status = await this.run([
      "status",
      "--porcelain",
      "--",
      ...pathspecs,
    ]);
    const diff = await this.run(["diff", "--", ...pathspecs]);
    return createHash("sha256")
      .update(status.stdout)
      .update("\0")
      .update(diff.stdout)
      .digest("hex");
  }

  async restoreWorktreeFromIndexExcept(paths: string[]): Promise<void> {
    const pathspecs = await this.protectedPathspecs(paths);
    await this.run(["restore", "-q", "--worktree", "--", ...pathspecs]);
    await this.run(["clean", "-fd", "--", ...pathspecs]);
  }

  async abortActiveOperation(): Promise<void> {
    const operation = await this.activeOperation();
    if (!operation) {
      return;
    }
    const command =
      operation === "cherry-pick"
        ? ["cherry-pick", "--abort"]
        : operation === "merge"
          ? ["merge", "--abort"]
          : operation === "revert"
            ? ["revert", "--abort"]
            : ["rebase", "--abort"];
    const result = await this.run(command, true);
    if (result.exitCode !== 0) {
      throw new Error(
        `${result.command} failed: ${result.stderr || result.stdout}`,
      );
    }
  }

  async restoreSnapshot(
    head: string,
    stagedPatch: string,
    workingPatch: string,
    protectedPaths: string[],
  ): Promise<void> {
    await this.resetHard(head);
    await this.restoreWorktreeFromIndexExcept(protectedPaths);
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-implement-snapshot-"));
    const stagedPath = join(tmpDir, "staged.patch");
    const workingPath = join(tmpDir, "working.patch");
    try {
      writeFileSync(stagedPath, stagedPatch, "utf-8");
      writeFileSync(workingPath, workingPatch, "utf-8");
      if (stagedPatch.trim()) {
        await this.run(["apply", "--index", "--whitespace=nowarn", stagedPath]);
      }
      if (workingPatch.trim()) {
        await this.run(["apply", "--whitespace=nowarn", workingPath]);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  async restoreStagedPatch(
    patch: string,
    protectedPaths: string[],
  ): Promise<void> {
    const pathspecs = await this.protectedPathspecs(protectedPaths);
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-implement-patch-"));
    const patchPath = join(tmpDir, "candidate.patch");
    try {
      writeFileSync(patchPath, patch, "utf-8");
      await this.run(["reset", "-q"]);
      await this.run(["restore", "-q", "--worktree", "--", ...pathspecs]);
      await this.run(["clean", "-fd", "--", ...pathspecs]);
      if (patch.trim()) {
        await this.run(["apply", "--index", "--whitespace=nowarn", patchPath]);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  async checkpoint(message: string, amend: boolean): Promise<CommandResult> {
    return this.run(
      amend
        ? ["commit", "--amend", "--no-verify", "-m", message]
        : ["commit", "--no-verify", "-m", message],
      true,
    );
  }

  async runCheckpointHooks(checkpoint: string): Promise<CommandResult> {
    const reset = await this.run(["reset", "--soft", `${checkpoint}^`], true);
    if (reset.exitCode !== 0) {
      return reset;
    }
    return this.run(["commit", "-C", checkpoint], true);
  }

  async rewordInternal(message: string): Promise<CommandResult> {
    return this.run(["commit", "--amend", "--no-verify", "-m", message], true);
  }

  async commit(message: string): Promise<CommandResult> {
    return this.run(["commit", "-m", message], true);
  }

  async reword(message: string): Promise<CommandResult> {
    return this.run(["commit", "--amend", "-m", message], true);
  }

  async mergeFastForward(commitSha: string): Promise<CommandResult> {
    return this.run(["merge", "--ff-only", commitSha], true);
  }

  async reset(): Promise<void> {
    await this.run(["reset"]);
  }

  async resetHard(commitSha: string): Promise<void> {
    await this.run(["reset", "--hard", commitSha]);
  }

  async aheadOfBase(branchName: string, baseSha: string): Promise<boolean> {
    const result = await this.run(
      ["rev-list", "--count", `${baseSha}..${branchName}`],
      true,
    );
    if (result.exitCode !== 0) {
      return false;
    }
    const count = parseInt(result.stdout.trim(), 10);
    return !isNaN(count) && count > 0;
  }

  async cherryPickNoCommit(commitSha: string): Promise<CommandResult> {
    return this.run(["cherry-pick", "--no-commit", commitSha], true);
  }

  async applyPatch(patch: string): Promise<CommandResult> {
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-implement-transplant-"));
    const patchPath = join(tmpDir, "candidate.patch");
    try {
      writeFileSync(patchPath, patch, "utf-8");
      return await this.run(
        ["apply", "--index", "--3way", "--whitespace=nowarn", patchPath],
        true,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  async cherryPickAbort(): Promise<void> {
    await this.run(["cherry-pick", "--abort"]);
  }

  async createTaskBranch(branchName: string, baseSha: string): Promise<void> {
    await this.run(
      ["branch", branchName, baseSha],
      false,
      undefined,
      "repository",
    );
  }

  async addWorktree(worktreePath: string, branchName: string): Promise<void> {
    await this.run(
      ["worktree", "add", worktreePath, branchName],
      false,
      undefined,
      "repository",
    );
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    await this.run(
      ["worktree", "remove", "--force", worktreePath],
      false,
      undefined,
      "repository",
    );
  }

  async deleteTaskBranch(branchName: string): Promise<void> {
    await this.run(
      ["branch", "-D", branchName],
      false,
      undefined,
      "repository",
    );
  }

  async diffRange(baseSha: string, headSha: string): Promise<string> {
    return (await this.run(["diff", "--binary", `${baseSha}..${headSha}`]))
      .stdout;
  }

  async diffRangeNameStatus(baseSha: string, headSha: string): Promise<string> {
    return (await this.run(["diff", "--name-status", `${baseSha}..${headSha}`]))
      .stdout;
  }

  async diffRangeExcept(
    baseSha: string,
    headSha: string,
    paths: string[],
  ): Promise<string> {
    return (
      await this.run([
        "diff",
        "--binary",
        `${baseSha}..${headSha}`,
        "--",
        ...(await this.protectedPathspecs(paths)),
      ])
    ).stdout;
  }

  async listBranchesMatching(pattern: string): Promise<string[]> {
    const result = await this.run(["branch", "--list", pattern]);
    return result.stdout
      .split("\n")
      .map((b) => b.trim().replace(/^\*\s*/, ""))
      .filter(Boolean);
  }

  async listWorktrees(): Promise<string[]> {
    const result = await this.run(["worktree", "list", "--porcelain"]);
    const paths: string[] = [];
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        paths.push(line.slice("worktree ".length).trim());
      }
    }
    return paths;
  }

  async ensureInfoExclude(pattern: string): Promise<void> {
    await ensureGitInfoExclude(this.cwd, pattern);
  }

  withSignal(signal?: AbortSignal): GitClient {
    return new ExecGitClient(this.cwd, this.mainRepoRoot, signal);
  }

  onIdle(): Promise<void> {
    return this.process.onIdle();
  }

  forWorktree(worktreePath: string, mainRepoRoot?: string): GitClient {
    return new ExecGitClient(
      worktreePath,
      mainRepoRoot ?? this.mainRepoRoot ?? this.cwd,
      this.signal,
    );
  }

  private async changedPaths(): Promise<string[]> {
    const result = await this.run([
      "ls-files",
      "-z",
      "--modified",
      "--deleted",
      "--others",
      "--exclude-standard",
    ]);
    return result.stdout.split("\0").filter(Boolean);
  }

  private async protectedPathspecs(paths: string[]): Promise<string[]> {
    const excludes = await this.pathspecs(paths, true);
    return [":/", ...excludes];
  }

  private async pathspecs(
    paths: string[],
    exclude: boolean,
  ): Promise<string[]> {
    return (await this.repoRelativePaths(paths)).map((path) =>
      exclude ? `:(top,literal,exclude)${path}` : `:(top,literal)${path}`,
    );
  }

  private async repoRelativePaths(paths: string[]): Promise<string[]> {
    const root = await this.root();
    const realRoot = safeRealpath(root);
    const sourceRoot = this.mainRepoRoot ?? root;
    const realSourceRoot = safeRealpath(sourceRoot);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const path of paths) {
      const rel = isAbsolute(path)
        ? (relativeInside(root, path) ??
          relativeInside(realRoot, path) ??
          relativeInside(sourceRoot, path) ??
          relativeInside(realSourceRoot, path))
        : path;
      if (!rel) {
        continue;
      }
      const gitPath = rel.replaceAll("\\", "/").replace(/^\.\//, "");
      if (seen.has(gitPath)) {
        continue;
      }
      seen.add(gitPath);
      result.push(gitPath);
    }
    return result;
  }

  private async run(
    args: string[],
    allowFailure = false,
    env?: NodeJS.ProcessEnv,
    scope: "checkout" | "repository" = "checkout",
    retry?: "idempotent",
  ): Promise<CommandResult> {
    return this.process.run(args, {
      cwd: this.cwd,
      env,
      signal: this.signal,
      allowFailure,
      scope,
      retry,
    });
  }
}

function relativeInside(root: string, path: string): string | undefined {
  const rel = relative(root, safeRealpath(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

function safeRealpath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

export function isCleanStatus(status: string): boolean {
  return status.trim().length === 0;
}
