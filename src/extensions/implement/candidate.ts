import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import type { GitClient } from "./git.js";

type ArtifactSnapshot =
  | { kind: "missing" }
  | { kind: "file"; hash: string; mode: number }
  | { kind: "symlink"; target: string };

export type TargetSnapshot = {
  head: string;
  indexFingerprint: string;
  worktreeFingerprint: string;
  untrackedPaths: string[];
  activeOperation?: string;
  protectedArtifacts: Map<string, ArtifactSnapshot>;
};

export async function captureRestoreSnapshot(
  git: GitClient,
  protectedPaths: string[],
): Promise<TargetSnapshot> {
  return {
    head: await git.head(),
    indexFingerprint: await git.stagedFingerprint(),
    worktreeFingerprint: await git.worktreeFingerprintExcept(protectedPaths),
    untrackedPaths: await git.nonignoredUntracked(),
    activeOperation: await git.activeOperation(),
    protectedArtifacts: snapshotProtectedArtifacts(protectedPaths),
  };
}

export async function snapshotChanged(
  git: GitClient,
  snapshot: TargetSnapshot,
  protectedPaths: string[],
): Promise<boolean> {
  const actual = await captureRestoreSnapshot(git, protectedPaths);
  return (
    actual.head !== snapshot.head ||
    actual.indexFingerprint !== snapshot.indexFingerprint ||
    actual.worktreeFingerprint !== snapshot.worktreeFingerprint ||
    !samePaths(actual.untrackedPaths, snapshot.untrackedPaths) ||
    actual.activeOperation !== snapshot.activeOperation ||
    !sameProtectedArtifacts(
      actual.protectedArtifacts,
      snapshot.protectedArtifacts,
    )
  );
}

function snapshotProtectedArtifacts(
  paths: string[],
): Map<string, ArtifactSnapshot> {
  return new Map(
    paths.map((path): [string, ArtifactSnapshot] => {
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        return [path, { kind: "missing" }];
      }
      if (stat.isSymbolicLink()) {
        return [path, { kind: "symlink", target: readlinkSync(path) }];
      }
      if (!stat.isFile()) {
        throw new Error(`cannot snapshot protected non-file artifact: ${path}`);
      }
      return [
        path,
        {
          kind: "file",
          hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
          mode: stat.mode & 0o777,
        },
      ];
    }),
  );
}

function samePaths(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  );
}

function sameProtectedArtifacts(
  left: Map<string, ArtifactSnapshot>,
  right: Map<string, ArtifactSnapshot>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [path, artifact] of left) {
    const comparison = right.get(path);
    if (!comparison || artifact.kind !== comparison.kind) {
      return false;
    }
    if (
      (artifact.kind === "file" &&
        comparison.kind === "file" &&
        (artifact.hash !== comparison.hash ||
          artifact.mode !== comparison.mode)) ||
      (artifact.kind === "symlink" &&
        comparison.kind === "symlink" &&
        artifact.target !== comparison.target)
    ) {
      return false;
    }
  }
  return true;
}
