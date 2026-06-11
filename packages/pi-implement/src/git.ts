import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
};

export type GitClient = {
  root(): Promise<string>;
  mainRoot(): Promise<string>;
  head(): Promise<string>;
  status(): Promise<string>;
  isClean(): Promise<boolean>;
  isCleanExcept(paths: string[]): Promise<boolean>;
  stageAllExcept(paths: string[]): Promise<void>;
  hasStagedChanges(): Promise<boolean>;
  stagedDiffStat(): Promise<string>;
  stagedNameStatus(): Promise<string>;
  stagedDiff(): Promise<string>;
  stagedFingerprint(): Promise<string>;
  worktreeFingerprintExcept(paths: string[]): Promise<string>;
  restoreWorktreeFromIndexExcept(paths: string[]): Promise<void>;
  restoreStagedPatch(patch: string, protectedPaths: string[]): Promise<void>;
  commit(message: string): Promise<CommandResult>;
  reword(message: string): Promise<CommandResult>;
  reset(): Promise<void>;
  resetHard(commitSha: string): Promise<void>;
  aheadOfBase(branchName: string, baseSha: string): Promise<boolean>;
  cherryPickNoCommit(commitSha: string): Promise<CommandResult>;
  cherryPickAbort(): Promise<void>;
  createTaskBranch(branchName: string, baseSha: string): Promise<void>;
  addWorktree(worktreePath: string, branchName: string): Promise<void>;
  removeWorktree(worktreePath: string): Promise<void>;
  deleteTaskBranch(branchName: string): Promise<void>;
  diffRange(baseSha: string, headSha: string): Promise<string>;
  listBranchesMatching(pattern: string): Promise<string[]>;
  listWorktrees(): Promise<string[]>;
  ensureInfoExclude(pattern: string): Promise<void>;
  forWorktree(worktreePath: string, mainRepoRoot?: string): GitClient;
};

export class ExecGitClient implements GitClient {
  constructor(
    private readonly cwd: string,
    private readonly mainRepoRoot?: string,
  ) {}

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

  async head(): Promise<string> {
    return (await this.run(["rev-parse", "HEAD"])).stdout.trim();
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

  async stagedFingerprint(): Promise<string> {
    const [tree, nameStatus, diff] = await Promise.all([
      this.run(["write-tree"]),
      this.stagedNameStatus(),
      this.stagedDiff(),
    ]);
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
    const [status, diff] = await Promise.all([
      this.run(["status", "--porcelain", "--", ...pathspecs]),
      this.run(["diff", "--", ...pathspecs]),
    ]);
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

  async commit(message: string): Promise<CommandResult> {
    return this.run(["commit", "-m", message], true);
  }

  async reword(message: string): Promise<CommandResult> {
    return this.run(["commit", "--amend", "-m", message], true);
  }

  async reset(): Promise<void> {
    await this.run(["reset"]);
  }

  async resetHard(commitSha: string): Promise<void> {
    await this.run(["reset", "--hard", commitSha], true);
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

  async cherryPickAbort(): Promise<void> {
    await this.run(["cherry-pick", "--abort"], true);
  }

  async createTaskBranch(branchName: string, baseSha: string): Promise<void> {
    await this.run(["branch", branchName, baseSha]);
  }

  async addWorktree(worktreePath: string, branchName: string): Promise<void> {
    await this.run(["worktree", "add", worktreePath, branchName]);
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    await this.run(["worktree", "remove", "--force", worktreePath], true);
  }

  async deleteTaskBranch(branchName: string): Promise<void> {
    await this.run(["branch", "-D", branchName], true);
  }

  async diffRange(baseSha: string, headSha: string): Promise<string> {
    return (await this.run(["diff", "--binary", `${baseSha}..${headSha}`]))
      .stdout;
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
    const commonDir = (
      await this.run([
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).stdout.trim();
    const infoDir = join(commonDir, "info");
    const excludePath = join(infoDir, "exclude");
    if (!existsSync(excludePath)) {
      mkdirSync(infoDir, { recursive: true });
      writeFileSync(excludePath, `${pattern}\n`, "utf-8");
      return;
    }
    const content = readFileSync(excludePath, "utf-8");
    const lines = content.split("\n");
    if (lines.includes(pattern)) {
      return;
    }
    writeFileSync(
      excludePath,
      `${content.endsWith("\n") ? content : `${content}\n`}${pattern}\n`,
      "utf-8",
    );
  }

  forWorktree(worktreePath: string, mainRepoRoot?: string): GitClient {
    return new ExecGitClient(
      worktreePath,
      mainRepoRoot ?? this.mainRepoRoot ?? this.cwd,
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
    const root = this.mainRepoRoot ?? (await this.root());
    const realRoot = safeRealpath(root);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const path of paths) {
      const rel = relativeInside(root, path) ?? relativeInside(realRoot, path);
      if (!rel) {
        continue;
      }
      const gitPath = rel.replaceAll("\\", "/");
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
  ): Promise<CommandResult> {
    try {
      const result = await execFileAsync("git", args, {
        cwd: this.cwd,
        maxBuffer: 20 * 1024 * 1024,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
        command: `git ${args.join(" ")}`,
      };
    } catch (err) {
      const error = err as {
        stdout?: string;
        stderr?: string;
        code?: number;
        message?: string;
      };
      const result = {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message ?? "",
        exitCode: typeof error.code === "number" ? error.code : 1,
        command: `git ${args.join(" ")}`,
      };
      if (allowFailure) {
        return result;
      }
      throw new Error(
        `${result.command} failed: ${result.stderr || result.stdout}`,
      );
    }
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
