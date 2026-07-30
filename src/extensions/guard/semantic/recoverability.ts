import { execFile } from "node:child_process";
import { lstat, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SAFE_PSEUDO_DEVICES = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/urandom",
  "/dev/random",
]);

export type FilesystemOperation =
  | "remove"
  | "replace-entry"
  | "replace-content";
type Snapshot = { root: string; tracked: Set<string>; changed: Set<string> };
type Repository =
  | { kind: "non-git" }
  | { kind: "failed" }
  | { kind: "snapshot"; value: Snapshot };

function inside(root: string, candidate: string): boolean {
  const part = relative(root, candidate);
  return part !== "" && !part.startsWith("..") && !isAbsolute(part);
}
function insideOrEqual(root: string, candidate: string): boolean {
  return root === candidate || inside(root, candidate);
}

async function nearestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

async function canonical(
  path: string,
  followFinal: boolean,
): Promise<string | undefined> {
  const absolute = resolve(path);
  try {
    if (followFinal) {
      return await realpath(absolute);
    }
    const parent = await realpath(await nearestExisting(dirname(absolute)));
    return resolve(parent, basename(absolute));
  } catch {
    return undefined;
  }
}

function changedPaths(root: string, output: string): Set<string> {
  const changed = new Set<string>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.length < 4) {
      continue;
    }
    const status = record.slice(0, 2);
    changed.add(resolve(root, record.slice(3)));
    if ((status[0] === "R" || status[0] === "C") && records[index + 1]) {
      changed.add(resolve(root, records[++index]!));
    }
  }
  return changed;
}

async function inspectRepository(directory: string): Promise<Repository> {
  let root: string;
  try {
    root = (
      await exec("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
        timeout: 5000,
      })
    ).stdout.trim();
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    return /not a git repository/i.test(stderr)
      ? { kind: "non-git" }
      : { kind: "failed" };
  }
  try {
    const [status, files] = await Promise.all([
      exec(
        "git",
        [
          "-C",
          root,
          "status",
          "--porcelain=v1",
          "-z",
          "--ignored",
          "--untracked-files=all",
        ],
        { timeout: 5000 },
      ),
      exec("git", ["-C", root, "ls-files", "-z"], { timeout: 5000 }),
    ]);
    return {
      kind: "snapshot",
      value: {
        root,
        tracked: new Set(
          files.stdout
            .split("\0")
            .filter(Boolean)
            .map((entry) => resolve(root, entry)),
        ),
        changed: changedPaths(root, status.stdout),
      },
    };
  } catch {
    return { kind: "failed" };
  }
}

async function leaves(path: string): Promise<string[] | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory()) {
      return [path];
    }
    const entries = await readdir(path, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => leaves(resolve(path, entry.name))),
    );
    const result: string[] = [];
    for (const entry of nested) {
      if (!entry) {
        return undefined;
      }
      result.push(...entry);
    }
    return result;
  } catch {
    return undefined;
  }
}

export type Recoverability = {
  cwd: string;
  repositories: Map<string, Promise<Repository>>;
  discoveries: Map<string, Promise<Repository>>;
};
export function createRecoverability(cwd: string): Recoverability {
  return { cwd, repositories: new Map(), discoveries: new Map() };
}

async function repositoryFor(
  path: string,
  state: Recoverability,
): Promise<Repository> {
  for (const pending of state.repositories.values()) {
    const repository = await pending;
    if (
      repository.kind === "snapshot" &&
      insideOrEqual(repository.value.root, path)
    ) {
      return repository;
    }
  }
  const directory = await canonical(await nearestExisting(dirname(path)), true);
  if (!directory) {
    return { kind: "failed" };
  }
  const existing = state.discoveries.get(directory);
  if (existing) {
    return existing;
  }
  const pending = inspectRepository(directory).then((repository) => {
    if (repository.kind === "snapshot") {
      state.repositories.set(
        repository.value.root,
        Promise.resolve(repository),
      );
    }
    return repository;
  });
  state.discoveries.set(directory, pending);
  return pending;
}

async function temporaryTarget(
  target: string,
  state: Recoverability,
  repository: Repository,
): Promise<boolean> {
  if (repository.kind === "failed") {
    return false;
  }
  const cwd = await canonical(state.cwd, true);
  if (!cwd || insideOrEqual(cwd, target)) {
    return false;
  }
  if (
    repository.kind === "snapshot" &&
    insideOrEqual(repository.value.root, target)
  ) {
    return false;
  }
  const roots = [
    ...new Set(
      [
        tmpdir(),
        "/tmp",
        "/var/tmp",
        process.env.TMPDIR,
        process.env.TMP,
        process.env.TEMP,
      ].filter((root): root is string => !!root),
    ),
  ];
  for (const root of roots) {
    const canonicalRoot = await canonical(root, true);
    if (canonicalRoot && inside(canonicalRoot, target)) {
      return true;
    }
  }
  return false;
}

export async function canonicalCandidates(
  target: string,
  operation: FilesystemOperation,
  state: Recoverability,
): Promise<string[]> {
  const absolute = resolve(state.cwd, target);
  const entry = await canonical(absolute, false);
  const followed =
    operation === "replace-content"
      ? await canonical(absolute, true)
      : undefined;
  return [
    ...new Set([entry, followed].filter((value): value is string => !!value)),
  ];
}

export async function hasUnrecoverableData(
  target: string,
  operation: FilesystemOperation,
  state: Recoverability,
): Promise<boolean> {
  const absolute = resolve(state.cwd, target);
  if (operation === "replace-content" && SAFE_PSEUDO_DEVICES.has(absolute)) {
    return false;
  }
  try {
    await lstat(absolute);
  } catch {
    return false;
  }
  const candidates = await canonicalCandidates(absolute, operation, state);
  if (!candidates.length) {
    return true;
  }
  const targetPath = candidates.at(-1)!;
  const repository = await repositoryFor(targetPath, state);
  if (await temporaryTarget(targetPath, state, repository)) {
    return false;
  }
  const affected = await leaves(targetPath);
  if (!affected) {
    return true;
  }
  if (!affected.length) {
    return false;
  }
  if (
    repository.kind !== "snapshot" ||
    !inside(repository.value.root, targetPath)
  ) {
    return true;
  }
  return affected.some(
    (leaf) =>
      !repository.value.tracked.has(leaf) || repository.value.changed.has(leaf),
  );
}
