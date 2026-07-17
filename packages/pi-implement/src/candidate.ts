import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { CommandResult, GitClient } from "./git.js";

export type CandidateMetadata = {
  sourceBaseSha: string;
  candidateBaseSha: string;
  branchName: string;
  worktreePath?: string;
  candidateSha?: string;
  candidateTree?: string;
  trustedCheckpoint?: string;
  discardedBundles: string[];
};

type ArtifactSnapshot =
  | { kind: "missing" }
  | { kind: "file"; content: Buffer; mode: number }
  | { kind: "symlink"; target: string };

export type ProtectedArtifactSnapshot = Map<string, ArtifactSnapshot>;

export type RestoreSnapshot = {
  head: string;
  indexFingerprint: string;
  worktreeFingerprint: string;
  untrackedPaths: string[];
  activeOperation?: string;
  stagedPatch: string;
  workingPatch: string;
  untrackedArtifacts: Map<string, UntrackedArtifact>;
  protectedArtifacts: ProtectedArtifactSnapshot;
};

type UntrackedArtifact =
  | { kind: "file"; content: Buffer; mode: number }
  | { kind: "symlink"; target: string };

export async function checkpointCandidate(
  git: GitClient,
  candidate: CandidateMetadata,
  message = "pi-implement: candidate",
): Promise<{
  candidate: CandidateMetadata;
  changed: boolean;
  result?: CommandResult;
}> {
  const beforeTree = candidate.candidateTree;
  const nextTree = await git.tree();
  if (beforeTree === nextTree) {
    return { candidate, changed: false };
  }
  const result = await git.checkpoint(
    message,
    Boolean(candidate.trustedCheckpoint),
  );
  if (result.exitCode !== 0) {
    return { candidate, changed: false, result };
  }
  const checkpoint = await git.head();
  return {
    changed: true,
    result,
    candidate: {
      ...candidate,
      candidateSha: checkpoint,
      candidateTree: nextTree,
      trustedCheckpoint: checkpoint,
    },
  };
}

export async function captureRestoreSnapshot(
  git: GitClient,
  protectedPaths: string[],
): Promise<RestoreSnapshot> {
  return {
    head: await git.head(),
    indexFingerprint: await git.stagedFingerprint(),
    worktreeFingerprint: await git.worktreeFingerprintExcept(protectedPaths),
    untrackedPaths: await git.nonignoredUntracked(),
    activeOperation: await git.activeOperation(),
    stagedPatch: await git.stagedDiff(),
    workingPatch: await git.workingDiff(),
    untrackedArtifacts: snapshotUntrackedArtifacts(
      await git.root(),
      await git.nonignoredUntracked(),
      protectedPaths,
    ),
    protectedArtifacts: snapshotProtectedArtifacts(protectedPaths),
  };
}

export function protectedArtifactsChanged(snapshot: RestoreSnapshot): boolean {
  return !sameProtectedArtifacts(
    snapshotProtectedArtifacts([...snapshot.protectedArtifacts.keys()]),
    snapshot.protectedArtifacts,
  );
}

export async function snapshotChanged(
  git: GitClient,
  snapshot: RestoreSnapshot,
  protectedPaths: string[],
  options: { ignoreHead?: boolean } = {},
): Promise<boolean> {
  const actual = await captureRestoreSnapshot(git, protectedPaths);
  return (
    (!options.ignoreHead && actual.head !== snapshot.head) ||
    actual.indexFingerprint !== snapshot.indexFingerprint ||
    actual.worktreeFingerprint !== snapshot.worktreeFingerprint ||
    !samePaths(actual.untrackedPaths, snapshot.untrackedPaths) ||
    !sameUntrackedArtifacts(
      actual.untrackedArtifacts,
      snapshot.untrackedArtifacts,
    ) ||
    actual.activeOperation !== snapshot.activeOperation ||
    !sameProtectedArtifacts(
      actual.protectedArtifacts,
      snapshot.protectedArtifacts,
    )
  );
}

export async function restoreAndVerify(
  git: GitClient,
  snapshot: RestoreSnapshot,
  protectedPaths: string[],
): Promise<void> {
  if (snapshot.activeOperation) {
    throw new Error(
      `cannot restore a pre-existing active Git operation: ${snapshot.activeOperation}`,
    );
  }
  await git.abortActiveOperation();
  await git.restoreSnapshot(
    snapshot.head,
    snapshot.stagedPatch,
    snapshot.workingPatch,
    protectedPaths,
  );
  await restoreUntrackedArtifacts(
    git,
    snapshot.untrackedArtifacts,
    protectedPaths,
  );
  restoreProtectedArtifacts(snapshot.protectedArtifacts);

  const actual = await captureRestoreSnapshot(git, protectedPaths);
  const mismatch = [
    actual.head !== snapshot.head ? "HEAD" : undefined,
    actual.indexFingerprint !== snapshot.indexFingerprint ? "index" : undefined,
    actual.worktreeFingerprint !== snapshot.worktreeFingerprint
      ? "tracked worktree"
      : undefined,
    !samePaths(actual.untrackedPaths, snapshot.untrackedPaths) ||
    !sameUntrackedArtifacts(
      actual.untrackedArtifacts,
      snapshot.untrackedArtifacts,
    )
      ? "nonignored untracked files"
      : undefined,
    actual.activeOperation !== snapshot.activeOperation
      ? "active Git operation"
      : undefined,
    !sameProtectedArtifacts(
      actual.protectedArtifacts,
      snapshot.protectedArtifacts,
    )
      ? "protected artifacts"
      : undefined,
  ].filter(Boolean);
  if (mismatch.length) {
    throw new Error(
      `restoration could not be proved for ${mismatch.join(", ")}`,
    );
  }
}

export function snapshotProtectedArtifacts(
  paths: string[],
): ProtectedArtifactSnapshot {
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
        { kind: "file", content: readFileSync(path), mode: stat.mode & 0o777 },
      ];
    }),
  );
}

export function restoreProtectedArtifacts(
  snapshot: ProtectedArtifactSnapshot,
): void {
  for (const [path, artifact] of snapshot) {
    rmSync(path, { recursive: true, force: true });
    if (artifact.kind === "missing") {
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    if (artifact.kind === "symlink") {
      symlinkSync(artifact.target, path);
    } else {
      writeFileSync(path, artifact.content, { mode: artifact.mode });
      chmodSync(path, artifact.mode);
    }
  }
}

export async function persistDiscardedBundle(args: {
  git: GitClient;
  destination: string;
  protectedPaths: string[];
  baseSha?: string;
}): Promise<string> {
  const { git, destination, protectedPaths, baseSha } = args;
  const root = await git.root();
  const untrackedPaths = (await git.nonignoredUntracked()).filter(
    (path) =>
      !protectedPaths.some((protectedPath) =>
        samePath(root, path, protectedPath),
      ),
  );
  mkdirSync(destination, { recursive: true });
  const status = await git.status();
  const [stagedPatch, workingPatch, head] = await Promise.all([
    git.stagedDiffExcept(protectedPaths),
    git.workingDiffExcept(protectedPaths),
    git.head(),
  ]);
  const trackedPatch = Buffer.from(
    ["# staged changes", stagedPatch, "# unstaged changes", workingPatch].join(
      "\n",
    ),
    "utf-8",
  );
  const committedPatch =
    baseSha && baseSha !== head
      ? await git.diffRangeExcept(baseSha, head, protectedPaths)
      : "";
  const manifest = {
    status,
    statusSha256: hash(status),
    stagedPatch: "staged.patch",
    stagedPatchSha256: hash(stagedPatch),
    workingPatch: "working.patch",
    workingPatchSha256: hash(workingPatch),
    trackedPatch: "tracked.patch",
    trackedPatchSha256: hash(trackedPatch),
    committedPatch: "committed.patch",
    committedPatchSha256: hash(committedPatch),
    untracked: untrackedPaths.map((path) => untrackedManifestEntry(root, path)),
    protectedArtifacts: protectedPaths.map((path) => relative(root, path)),
  };
  writeFileSync(join(destination, "status.txt"), status);
  writeFileSync(join(destination, "staged.patch"), stagedPatch);
  writeFileSync(join(destination, "working.patch"), workingPatch);
  writeFileSync(join(destination, "tracked.patch"), trackedPatch);
  writeFileSync(join(destination, "committed.patch"), committedPatch);
  writeFileSync(
    join(destination, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  const archive = join(destination, "untracked.tar.gz");
  if (untrackedPaths.length) {
    for (const path of untrackedPaths) {
      safeArtifactPath(root, path);
    }
    execFileSync(
      "tar",
      ["--no-recursion", "-czf", archive, "--", ...untrackedPaths],
      {
        cwd: root,
      },
    );
  } else {
    writeFileSync(archive, "");
  }
  writeFileSync(
    join(destination, "manifest.json"),
    JSON.stringify(
      {
        ...manifest,
        untrackedArchive: "untracked.tar.gz",
        untrackedArchiveSha256: hash(readFileSync(archive)),
      },
      null,
      2,
    ),
  );
  return destination;
}

function snapshotUntrackedArtifacts(
  root: string,
  paths: string[],
  protectedPaths: string[],
): Map<string, UntrackedArtifact> {
  return new Map<string, UntrackedArtifact>(
    paths
      .filter(
        (path) =>
          !protectedPaths.some((protectedPath) =>
            samePath(root, path, protectedPath),
          ),
      )
      .map((path): [string, UntrackedArtifact] => {
        const absolute = safeArtifactPath(root, path);
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          return [
            path,
            { kind: "symlink", target: readlinkSync(absolute) },
          ] as const;
        }
        if (!stat.isFile()) {
          throw new Error(`cannot snapshot non-file untracked path: ${path}`);
        }
        return [
          path,
          {
            kind: "file",
            content: readFileSync(absolute),
            mode: stat.mode & 0o777,
          },
        ] as const;
      }),
  );
}

async function restoreUntrackedArtifacts(
  git: GitClient,
  artifacts: Map<string, UntrackedArtifact>,
  protectedPaths: string[],
): Promise<void> {
  const root = await git.root();
  const protectedSet = new Set(protectedPaths.map((path) => resolve(path)));
  const existing = await git.nonignoredUntracked();
  for (const path of existing) {
    const absolute = safeArtifactPath(root, path);
    if (!protectedSet.has(absolute)) {
      rmSync(absolute, { recursive: true, force: true });
    }
  }
  for (const [path, artifact] of artifacts) {
    const absolute = safeArtifactPath(root, path);
    if (protectedSet.has(absolute)) {
      continue;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    if (artifact.kind === "symlink") {
      symlinkSync(artifact.target, absolute);
    } else {
      writeFileSync(absolute, artifact.content, { mode: artifact.mode });
      chmodSync(absolute, artifact.mode);
    }
  }
}

function untrackedManifestEntry(root: string, path: string) {
  const absolute = safeArtifactPath(root, path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(absolute);
    return {
      path,
      kind: "symlink",
      target,
      sha256: hash(target),
      bytes: Buffer.byteLength(target),
    };
  }
  if (!stat.isFile()) {
    throw new Error(`cannot archive non-file untracked path: ${path}`);
  }
  const content = readFileSync(absolute);
  return { path, kind: "file", sha256: hash(content), bytes: stat.size };
}

function safeArtifactPath(root: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`unsafe untracked path: ${path}`);
  }
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}/`)) {
    throw new Error(`untracked path escapes repository: ${path}`);
  }
  return absolute;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function samePaths(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  );
}

function sameUntrackedArtifacts(
  left: Map<string, UntrackedArtifact>,
  right: Map<string, UntrackedArtifact>,
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
        (!artifact.content.equals(comparison.content) ||
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

function sameProtectedArtifacts(
  left: ProtectedArtifactSnapshot,
  right: ProtectedArtifactSnapshot,
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
        (!artifact.content.equals(comparison.content) ||
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

function samePath(root: string, path: string, protectedPath: string): boolean {
  return (
    join(root, path) === protectedPath ||
    (basename(path) === basename(protectedPath) &&
      join(root, path) === protectedPath)
  );
}
