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
  /** Dependency-installation authorities used only by workspace-write sessions. */
  dependencyRoots: readonly string[];
  writableRoots: readonly string[];
  creationRoots: readonly string[];
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

export function canonicalRoot(path: string): Readonly<{
  path: string;
  creationRoots: readonly string[];
}> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new SandboxPolicyError("root must be an absolute path");
  }
  const missing: string[] = [];
  let cursor = path;
  while (true) {
    try {
      let canonical = realpathSync(cursor);
      const missingComponents = missing.reverse();
      if (missingComponents.includes("..")) {
        return canonicalRoot(resolve(canonical, ...missingComponents));
      }
      const creationRoots = missingComponents.map((component) => {
        canonical = resolve(canonical, component);
        return canonical;
      });
      return Object.freeze({
        path: canonical,
        creationRoots: Object.freeze(creationRoots),
      });
    } catch {
      try {
        lstatSync(cursor);
        throw new SandboxPolicyError(`unable to canonicalize root: ${path}`);
      } catch (lstatError) {
        if (lstatError instanceof SandboxPolicyError) {
          throw lstatError;
        }
        if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new SandboxPolicyError(`unable to canonicalize root: ${path}`);
        }
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new SandboxPolicyError(`unable to canonicalize root: ${path}`);
      }
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function canonicalPath(path: string): string {
  return canonicalRoot(path).path;
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

type RootCandidate = Readonly<{
  path: string;
  creationRoots: readonly string[];
}>;

function rootCandidate(value: string): RootCandidate | undefined {
  if (!isAbsolute(value)) {
    return undefined;
  }
  try {
    try {
      if (!statSync(value).isDirectory()) {
        return undefined;
      }
    } catch {}
    return canonicalRoot(value);
  } catch {
    return undefined;
  }
}

function ancestorPackageWorkspace(workspaceRoot: string): string | undefined {
  let cursor = dirname(workspaceRoot);
  while (true) {
    try {
      if (statSync(join(cursor, "package.json")).isFile()) {
        return cursor;
      }
    } catch {}
    const parent = dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

async function dependencyInstallationRoots(
  workspaceRoot: string,
  gitRunner: GitRunner,
): Promise<readonly string[]> {
  const candidate = ancestorPackageWorkspace(workspaceRoot);
  if (!candidate) {
    return [];
  }
  const worktrees = await gitRunner(workspaceRoot, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  if (worktrees.exitCode !== 0) {
    return [];
  }
  let packageWorkspace: string;
  try {
    packageWorkspace = canonicalExisting(candidate);
  } catch {
    return [];
  }
  const registered = worktrees.stdout
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
  if (
    !registered.some((path) => {
      try {
        return canonicalExisting(path) === packageWorkspace;
      } catch {
        return false;
      }
    })
  ) {
    return [];
  }
  const manifests = await gitRunner(packageWorkspace, [
    "ls-files",
    "-z",
    "--",
    "package.json",
    ":(glob)**/package.json",
  ]);
  if (manifests.exitCode !== 0) {
    return [];
  }
  const roots = manifests.stdout.split("\0").flatMap((manifest) => {
    if (!manifest) {
      return [];
    }
    const path = join(packageWorkspace, dirname(manifest), "node_modules");
    try {
      const canonical = canonicalExisting(path);
      return isUnder(canonical, packageWorkspace) ? [canonical] : [];
    } catch {
      return [];
    }
  });
  return normalizeRoots(roots);
}

export async function resolveSandboxPolicy(
  options: Readonly<{
    sessionCwd: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    temporaryDir?: string;
    standardTemporaryRoots?: readonly string[];
    gitRunner?: GitRunner;
  }>,
): Promise<SandboxPolicy> {
  const sessionCwd = canonicalExisting(options.sessionCwd);
  const gitRunner = options.gitRunner ?? runGit;
  const git = await resolveGit(sessionCwd, gitRunner);
  const workspaceRoot = git?.worktreeRoot ?? sessionCwd;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const temporaryRoots = normalizeRoots(
    [
      absoluteDirectory(env.TMPDIR),
      absoluteDirectory(options.temporaryDir ?? tmpdir()),
      ...(options.standardTemporaryRoots ?? ["/tmp", "/var/tmp"]).map(
        absoluteDirectory,
      ),
    ].filter((root): root is string => root !== undefined),
  );
  const protectedGhCandidates = [
    env.GH_CONFIG_DIR ||
      (env.XDG_CONFIG_HOME
        ? join(env.XDG_CONFIG_HOME, "gh")
        : join(home, ".config", "gh")),
    env.XDG_DATA_HOME
      ? join(env.XDG_DATA_HOME, "gh")
      : join(home, ".local", "share", "gh"),
  ]
    .map(rootCandidate)
    .filter((root): root is RootCandidate => root !== undefined);
  const doesNotOverlapProtectedGhRoot = (candidate: RootCandidate): boolean =>
    !protectedGhCandidates.some(
      (protectedRoot) =>
        isUnder(candidate.path, protectedRoot.path) ||
        isUnder(protectedRoot.path, candidate.path),
    );
  const cacheCandidates = [
    env.npm_config_cache ?? join(home, ".npm"),
    join(home, "Library", "pnpm", "store"),
    join(home, "Library", "Caches", "pnpm"),
    env.XDG_CACHE_HOME
      ? join(env.XDG_CACHE_HOME, "gh")
      : join(home, ".cache", "gh"),
  ]
    .map(rootCandidate)
    .filter(
      (root): root is RootCandidate =>
        root !== undefined && doesNotOverlapProtectedGhRoot(root),
    );
  const cacheRoots = normalizeRoots(cacheCandidates.map((root) => root.path));
  const stateCandidates = [
    env.XDG_STATE_HOME
      ? join(env.XDG_STATE_HOME, "gh")
      : join(home, ".local", "state", "gh"),
  ]
    .map(rootCandidate)
    .filter(
      (root): root is RootCandidate =>
        root !== undefined && doesNotOverlapProtectedGhRoot(root),
    );
  const stateRoots = normalizeRoots(stateCandidates.map((root) => root.path));
  const dependencyRoots = git
    ? await dependencyInstallationRoots(workspaceRoot, gitRunner)
    : [];
  const writableRoots = normalizeRoots([
    workspaceRoot,
    ...(git ? [git.worktreeGitDir, git.commonGitDir] : []),
    ...temporaryRoots,
    ...cacheRoots,
    ...stateRoots,
    ...dependencyRoots,
  ]);
  const recursiveRoots = new Set(writableRoots);
  const creationRoots = Object.freeze([
    ...new Set(
      [...cacheCandidates, ...stateCandidates].flatMap((root) =>
        recursiveRoots.has(root.path) ? root.creationRoots.slice(0, -1) : [],
      ),
    ),
  ]);
  return Object.freeze({
    sessionCwd,
    workspaceRoot,
    ...(git ? { git } : {}),
    temporaryRoots,
    cacheRoots,
    dependencyRoots,
    writableRoots,
    creationRoots,
  });
}

export function pathIsWithin(path: string, root: string): boolean {
  return isUnder(path, root);
}
