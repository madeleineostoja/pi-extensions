import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
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
  commit(message: string): Promise<CommandResult>;
  reset(): Promise<void>;
};

export class ExecGitClient implements GitClient {
  constructor(private readonly cwd: string) {}

  async root(): Promise<string> {
    return (await this.run(["rev-parse", "--show-toplevel"])).stdout.trim();
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

  async stagedDiff(): Promise<string> {
    return (await this.run(["diff", "--cached", "HEAD"])).stdout;
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

  async commit(message: string): Promise<CommandResult> {
    return this.run(["commit", "-m", message], true);
  }

  async reset(): Promise<void> {
    await this.run(["reset"]);
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
