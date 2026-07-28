import { execFile } from "node:child_process";
import { lstat, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SAFE_DEVICES = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/urandom",
  "/dev/random",
]);

type Snapshot = {
  root: string;
  tracked: Set<string>;
  changed: Set<string>;
  failed: boolean;
};

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

async function snapshotFor(
  path: string,
  cache: Map<string, Promise<Snapshot | undefined>>,
): Promise<Snapshot | undefined> {
  const start = await nearestExisting(dirname(path));
  const directory = await canonical(start, true);
  if (!directory) {
    return undefined;
  }
  let root: string;
  try {
    root = (
      await exec("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
        timeout: 5000,
      })
    ).stdout.trim();
  } catch {
    return undefined;
  }
  const existing = cache.get(root);
  if (existing) {
    return existing;
  }
  const pending = (async () => {
    try {
      const [status, files] = await Promise.all([
        exec(
          "git",
          [
            "-C",
            root,
            "status",
            "--porcelain=v1",
            "--ignored",
            "--untracked-files=all",
          ],
          { timeout: 5000 },
        ),
        exec("git", ["-C", root, "ls-files", "-z"], { timeout: 5000 }),
      ]);
      const changed = new Set<string>();
      for (const line of status.stdout.split("\n")) {
        if (line.length > 3) {
          changed.add(resolve(root, line.slice(3)));
        }
      }
      return {
        root,
        tracked: new Set(
          files.stdout
            .split("\0")
            .filter(Boolean)
            .map((entry) => resolve(root, entry)),
        ),
        changed,
        failed: false,
      };
    } catch {
      return undefined;
    }
  })();
  cache.set(root, pending);
  return pending;
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
    return nested.flatMap((entry) => entry ?? []);
  } catch {
    return undefined;
  }
}

export type Recoverability = {
  cwd: string;
  snapshots: Map<string, Promise<Snapshot | undefined>>;
};
export function createRecoverability(cwd: string): Recoverability {
  return { cwd, snapshots: new Map() };
}

export async function isRecoverable(
  target: string,
  operation: "remove" | "follow" | "overwrite",
  state: Recoverability,
): Promise<boolean> {
  const absolute = resolve(state.cwd, target);
  if (SAFE_DEVICES.has(absolute)) {
    return true;
  }
  try {
    const stat = await lstat(absolute);
    if (operation === "overwrite" && stat.isSymbolicLink()) {
      return false;
    }
  } catch {
    return operation === "overwrite";
  }
  const canonicalTarget = await canonical(absolute, operation !== "remove");
  if (!canonicalTarget) {
    return false;
  }
  const snapshot = await snapshotFor(canonicalTarget, state.snapshots);
  const cwd = await canonical(state.cwd, true);
  if (!cwd) {
    return false;
  }
  const temp = await canonical(tmpdir(), true);
  if (
    temp &&
    inside(temp, canonicalTarget) &&
    !insideOrEqual(cwd, canonicalTarget) &&
    !(snapshot && insideOrEqual(snapshot.root, canonicalTarget))
  ) {
    return true;
  }
  if (!snapshot || !inside(snapshot.root, canonicalTarget)) {
    return false;
  }
  const affected = await leaves(canonicalTarget);
  if (!affected?.length) {
    return false;
  }
  return affected.every(
    (leaf) => snapshot.tracked.has(leaf) && !snapshot.changed.has(leaf),
  );
}
