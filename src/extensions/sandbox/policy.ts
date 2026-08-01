import { spawn } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type SandboxGit = Readonly<{
  worktreeRoot: string;
  worktreeGitDir: string;
  commonGitDir: string;
}>;

export type SandboxPolicy = Readonly<{
  sessionCwd: string;
  workspaceRoot: string;
  git?: SandboxGit;
  temporaryRoots: readonly string[];
  cacheRoots: readonly string[];
  writableRoots: readonly string[];
}>;

export type GitRunResult = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

export type GitRunner = (
  cwd: string,
  args: readonly string[],
) => Promise<GitRunResult>;

export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(`Sandbox: ${message}`);
  }
}

function isUnder(path: string, root: string): boolean {
  const value = relative(root, path);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}

function canonicalExisting(path: string): string {
  const canonical = realpathSync(path);
  if (!lstatSync(canonical).isDirectory()) {
    throw new SandboxPolicyError(`root is not a directory: ${path}`);
  }
  return canonical;
}

export function canonicalPath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new SandboxPolicyError("root must be an absolute path");
  }
  const missing: string[] = [];
  let cursor = path;
  while (true) {
    try {
      const canonical = realpathSync(cursor);
      return resolve(canonical, ...missing.reverse());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new SandboxPolicyError(`unable to canonicalize root: ${path}`);
      }
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function normalizeRoots(roots: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  for (const root of roots) {
    const canonical = canonicalPath(root);
    if (!normalized.some((current) => current === canonical)) {
      normalized.push(canonical);
    }
  }
  return Object.freeze(
    normalized.filter(
      (root, index, all) =>
        !all.some(
          (parent, parentIndex) =>
            parentIndex !== index && isUnder(root, parent),
        ),
    ),
  );
}

export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolveResult, reject) => {
    let child;
    try {
      child = spawn("git", [...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => (stdout += data));
    child.stderr.on("data", (data: Buffer) => (stderr += data));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolveResult({ exitCode, stdout, stderr }),
    );
  });

function isNotWorktree(result: GitRunResult): boolean {
  return (
    result.exitCode === 128 &&
    /not a git repository|must be run in a work tree/i.test(result.stderr)
  );
}

async function resolveGit(
  cwd: string,
  gitRunner: GitRunner,
): Promise<SandboxGit | undefined> {
  let result: GitRunResult;
  try {
    result = await gitRunner(cwd, [
      "rev-parse",
      "--is-inside-work-tree",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ]);
  } catch (error) {
    throw new SandboxPolicyError(
      `Git resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (isNotWorktree(result)) {
    return undefined;
  }
  const lines = result.stdout.trim().split(/\r?\n/);
  if (result.exitCode !== 0 || lines.length !== 4 || lines[0] !== "true") {
    throw new SandboxPolicyError(
      `Git resolution failed: ${result.stderr.trim() || "unexpected Git response"}`,
    );
  }
  return Object.freeze({
    worktreeRoot: canonicalExisting(resolve(cwd, lines[1])),
    worktreeGitDir: canonicalExisting(resolve(cwd, lines[2])),
    commonGitDir: canonicalExisting(resolve(cwd, lines[3])),
  });
}

function absoluteDirectory(value: string | undefined): string | undefined {
  if (!value || !isAbsolute(value)) {
    return undefined;
  }
  try {
    return canonicalExisting(value);
  } catch {
    return undefined;
  }
}

function cacheRoot(value: string): string | undefined {
  if (!isAbsolute(value)) {
    return undefined;
  }
  try {
    try {
      if (!statSync(value).isDirectory()) {
        return undefined;
      }
    } catch {}
    return canonicalPath(value);
  } catch {
    return undefined;
  }
}

export async function resolveSandboxPolicy(
  options: Readonly<{
    sessionCwd: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    temporaryDir?: string;
    gitRunner?: GitRunner;
  }>,
): Promise<SandboxPolicy> {
  const sessionCwd = canonicalExisting(options.sessionCwd);
  const git = await resolveGit(sessionCwd, options.gitRunner ?? runGit);
  const workspaceRoot = git?.worktreeRoot ?? sessionCwd;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const temporaryRoots = normalizeRoots(
    [
      absoluteDirectory(env.TMPDIR),
      absoluteDirectory(options.temporaryDir ?? tmpdir()),
      absoluteDirectory("/tmp"),
      absoluteDirectory("/var/tmp"),
    ].filter((root): root is string => root !== undefined),
  );
  const cacheCandidates = [
    env.npm_config_cache ?? join(home, ".npm"),
    env.XDG_CACHE_HOME,
    join(home, "Library", "pnpm", "store"),
    join(home, "Library", "Caches", "pnpm"),
  ]
    .flatMap((root) => (root ? [cacheRoot(root)] : []))
    .filter((root): root is string => root !== undefined);
  const cacheRoots = normalizeRoots(cacheCandidates);
  const writableRoots = normalizeRoots([
    workspaceRoot,
    ...(git ? [git.worktreeGitDir, git.commonGitDir] : []),
    ...temporaryRoots,
    ...cacheRoots,
  ]);
  return Object.freeze({
    sessionCwd,
    workspaceRoot,
    ...(git ? { git } : {}),
    temporaryRoots,
    cacheRoots,
    writableRoots,
  });
}

export function pathIsWithin(path: string, root: string): boolean {
  return isUnder(path, root);
}
