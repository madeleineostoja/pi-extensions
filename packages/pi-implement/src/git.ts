import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
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

export async function changedPathsBetween(
  git: GitClient,
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  if (baseSha === headSha) {
    return [];
  }
  if (git.changedPathsBetween) {
    return [...new Set(await git.changedPathsBetween(baseSha, headSha))].sort();
  }
  return [
    ...new Set(
      (await git.diffRange(baseSha, headSha)).split("\n").flatMap((line) => {
        const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
        return match ? [match[1]!, match[2]!] : [];
      }),
    ),
  ].sort();
}

export type GitClient = {
  root(): Promise<string>;
  checkoutIdentity(): Promise<string>;
  currentBranch(): Promise<string>;
  activeOperation(): Promise<string | undefined>;
  head(): Promise<string>;
  parent(commit: string): Promise<string>;
  tree(): Promise<string>;
  treeAt(commit: string): Promise<string>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  isClean(): Promise<boolean>;
  isCleanExcept(paths: string[]): Promise<boolean>;
  hasStagedChanges(): Promise<boolean>;
  hasStagedChangesInPaths(paths: string[]): Promise<boolean>;
  stagedNameStatus(): Promise<string>;
  stagedDiff(): Promise<string>;
  nonignoredUntracked(): Promise<string[]>;
  abortActiveOperation(): Promise<void>;
  stagedFingerprint(): Promise<string>;
  worktreeFingerprintExcept(paths: string[]): Promise<string>;
  restoreWorktreeFromIndexExcept(paths: string[]): Promise<void>;
  checkpoint(message: string, amend: boolean): Promise<CommandResult>;
  updateRef?(
    ref: string,
    nextSha: string,
    expectedSha: string,
  ): Promise<CommandResult>;
  resetHard(commitSha: string): Promise<void>;
  synchronizeWorktree?(commitSha: string): Promise<void>;
  applyPatch(patch: string): Promise<CommandResult>;
  createTaskBranch(branchName: string, baseSha: string): Promise<void>;
  addWorktree(worktreePath: string, branchName: string): Promise<void>;
  removeWorktree(worktreePath: string): Promise<void>;
  deleteTaskBranch(branchName: string): Promise<void>;
  diffRange(baseSha: string, headSha: string): Promise<string>;
  changedPathsBetween?(baseSha: string, headSha: string): Promise<string[]>;
  listBranchesMatching(pattern: string): Promise<string[]>;
  branchTip?(branchName: string): Promise<string | undefined>;
  listWorktrees(): Promise<string[]>;
  forWorktree(worktreePath: string, mainRepoRoot?: string): GitClient;
  withSignal?(signal?: AbortSignal): GitClient;
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

  async isClean(): Promise<boolean> {
    return isCleanStatus((await this.run(["status", "--porcelain"])).stdout);
  }

  async isCleanExcept(paths: string[]): Promise<boolean> {
    const excludes = await this.pathspecs(paths, true);
    const status = (
      await this.run(["status", "--porcelain", "--", ":/", ...excludes])
    ).stdout;
    return isCleanStatus(status);
  }

  async hasStagedChanges(): Promise<boolean> {
    return this.hasStagedChangesInPaths([]);
  }

  async hasStagedChangesInPaths(paths: string[]): Promise<boolean> {
    const pathspecs = await this.pathspecs(paths, false);
    const result = await this.run(
      ["diff", "--cached", "--quiet", "HEAD", "--", ...pathspecs],
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

  async stagedNameStatus(): Promise<string> {
    return (await this.run(["diff", "--cached", "--name-status", "HEAD"]))
      .stdout;
  }

  async stagedDiff(): Promise<string> {
    return (await this.run(["diff", "--cached", "--binary", "HEAD"])).stdout;
  }

  async nonignoredUntracked(): Promise<string[]> {
    return (
      await this.run(["ls-files", "--others", "--exclude-standard", "-z"])
    ).stdout
      .split("\0")
      .filter(Boolean)
      .sort();
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

  async checkpoint(message: string, amend: boolean): Promise<CommandResult> {
    return this.run(
      amend ? ["commit", "--amend", "-m", message] : ["commit", "-m", message],
      true,
    );
  }

  async updateRef(
    ref: string,
    nextSha: string,
    expectedSha: string,
  ): Promise<CommandResult> {
    return this.run(
      ["update-ref", ref, nextSha, expectedSha],
      true,
      undefined,
      "repository",
      "idempotent",
    );
  }

  async resetHard(commitSha: string): Promise<void> {
    await this.run(["reset", "--hard", commitSha]);
  }

  async synchronizeWorktree(commitSha: string): Promise<void> {
    await this.run(["read-tree", "--reset", "-u", commitSha]);
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

  async changedPathsBetween(
    baseSha: string,
    headSha: string,
  ): Promise<string[]> {
    return (
      await this.run([
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        `${baseSha}..${headSha}`,
      ])
    ).stdout
      .split("\0")
      .filter(Boolean);
  }

  async listBranchesMatching(pattern: string): Promise<string[]> {
    const result = await this.run(["branch", "--list", pattern]);
    return result.stdout
      .split("\n")
      .map((b) => b.trim().replace(/^[*+]\s*/, ""))
      .filter(Boolean);
  }

  async branchTip(branchName: string): Promise<string | undefined> {
    const result = await this.run(
      ["rev-parse", "-q", "--verify", branchName],
      true,
    );
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
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

  withSignal(signal?: AbortSignal): GitClient {
    return new ExecGitClient(this.cwd, this.mainRepoRoot, signal);
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
