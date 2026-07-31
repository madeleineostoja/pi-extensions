import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { stagingIdentity } from "./candidate-replay.js";
import { sha256 } from "./source-integrity.js";
import type { GitClient } from "./git.js";
import type { CheckoutLeaseCapability, RunState, RunStore } from "./store.js";

type OwnedResource = {
  branchName: string;
  worktreePath: string;
  commits: Set<string>;
};

export async function sweepOwnedRunResources(args: {
  lease: CheckoutLeaseCapability;
  store: RunStore;
  git: GitClient;
}): Promise<void> {
  args.lease.assertOwned();
  const state = args.store.read();
  const expected = ownedResources(state);
  const root = runWorktreesRoot(args.lease, state.run.id);
  const prefix = `pipkin/implement/${state.run.id}/`;
  let [worktrees, branches] = await Promise.all([
    args.git.listWorktrees(),
    args.git.listBranchesMatching(`${prefix}*`),
  ]);
  let registered = worktrees.filter((path) => isUnder(root, path));
  let namespacedBranches = branches.filter((branch) =>
    branch.startsWith(prefix),
  );
  for (const path of registered) {
    if (
      [...expected.values()].some((resource) =>
        samePath(resource.worktreePath, path),
      )
    ) {
      continue;
    }
    const stagingId = basename(path);
    const workspace = args.git.forWorktree(path);
    if (
      !stagingId.startsWith("staging-") ||
      (await workspace.currentBranch()) !== `${prefix}${stagingId}`
    ) {
      continue;
    }
    await args.git.removeWorktree(path);
    await args.git.deleteTaskBranch(`${prefix}${stagingId}`);
  }
  [worktrees, branches] = await Promise.all([
    args.git.listWorktrees(),
    args.git.listBranchesMatching(`${prefix}*`),
  ]);
  registered = worktrees.filter((path) => isUnder(root, path));
  namespacedBranches = branches.filter((branch) => branch.startsWith(prefix));

  for (const path of registered) {
    const resource = [...expected.values()].find((candidate) =>
      samePath(candidate.worktreePath, path),
    );
    if (!resource) {
      throw manualRecovery(`Unexpected owned worktree: ${path}`);
    }
    const workspace = args.git.forWorktree(path);
    const [branch, head, clean, operation] = await Promise.all([
      workspace.currentBranch(),
      workspace.head(),
      workspace.isClean(),
      workspace.activeOperation(),
    ]);
    if (
      (branch !== resource.branchName &&
        (branch || namespacedBranches.includes(resource.branchName))) ||
      !resource.commits.has(head) ||
      !clean ||
      operation
    ) {
      throw manualRecovery(`Worktree cannot be proved owned: ${path}`);
    }
  }

  for (const branch of namespacedBranches) {
    const resource = expected.get(branch);
    const tip = await args.git.branchTip?.(branch);
    if (!resource || tip === undefined || !resource.commits.has(tip)) {
      throw manualRecovery(`Branch cannot be proved owned: ${branch}`);
    }
  }

  for (const path of registered) {
    await args.git.removeWorktree(path);
  }
  for (const branch of namespacedBranches) {
    await args.git.deleteTaskBranch(branch);
  }

  const remaining = await remainingOwnedResources(args.git, root, prefix);
  if (remaining.length > 0) {
    throw manualRecovery(
      `Owned resources remain after cleanup: ${remaining.join(", ")}`,
    );
  }
}

export function projectedArtifactPaths(state: RunState): string[] {
  return Object.entries(state.protectedArtifactHashes)
    .filter(([path, hash]) => {
      try {
        return (
          sha256(readFileSync(path, "utf-8")) === hash &&
          state.run.source.protectedArtifactHashes[path] !== hash
        );
      } catch {
        return false;
      }
    })
    .map(([path]) => path);
}

export function trashRun(args: {
  lease: CheckoutLeaseCapability;
  store: RunStore;
}): void {
  args.lease.assertOwned();
  if (Object.keys(args.store.read().processLeases).length > 0) {
    throw new Error("Run retains active process leases and cannot be removed.");
  }
  const runDirectory = join(args.lease.paths.runs, args.store.read().run.id);
  const trashDirectory = join(args.lease.paths.trash, args.store.read().run.id);
  mkdirSync(args.lease.paths.trash, { recursive: true });
  if (existsSync(trashDirectory)) {
    rmSync(trashDirectory, { recursive: true, force: true });
    return;
  }
  if (!existsSync(runDirectory)) {
    return;
  }
  renameSync(runDirectory, trashDirectory);
  rmSync(trashDirectory, { recursive: true, force: true });
}

export function runWorktreesRoot(
  lease: CheckoutLeaseCapability,
  runId: string,
): string {
  return join(lease.paths.worktrees, runId);
}

function ownedResources(state: RunState): Map<string, OwnedResource> {
  const resources = new Map<string, OwnedResource>();
  const root = join(
    state.run.checkout.root,
    ".pi",
    "pipkin",
    "implement",
    "worktrees",
    state.run.id,
  );
  const add = (branchName: string, worktreePath: string, commit: string) => {
    const current = resources.get(branchName);
    if (current) {
      current.commits.add(commit);
      return;
    }
    resources.set(branchName, {
      branchName,
      worktreePath,
      commits: new Set([commit]),
    });
  };
  for (const candidate of Object.values(state.candidates)) {
    const id =
      candidate.workstream.kind === "source"
        ? candidate.workstream.id
        : candidate.workstream.repairId;
    add(
      `pipkin/implement/${state.run.id}/${id}`,
      join(root, id),
      candidate.commitSha,
    );
  }
  for (const preparation of Object.values(state.publication.preparations)) {
    add(
      preparation.stagingBranch,
      preparation.stagingWorktree,
      preparation.preparedCommitSha,
    );
  }
  for (const assessment of Object.values(state.satisfaction.assessments)) {
    const candidate = state.candidates[assessment.candidateId];
    if (!candidate || !assessment.operationId) {
      continue;
    }
    const staging = stagingIdentity({
      runId: state.run.id,
      operationId: assessment.operationId,
      candidateId: candidate.id,
      candidateCommitSha: candidate.commitSha,
      candidateTreeSha: candidate.treeSha,
      targetBaseSha: assessment.targetSha,
      targetRef: state.run.checkout.branchRef,
    });
    add(staging.branchName, join(root, staging.id), assessment.targetSha);
  }
  return resources;
}

async function remainingOwnedResources(
  git: GitClient,
  root: string,
  prefix: string,
): Promise<string[]> {
  const [worktrees, branches] = await Promise.all([
    git.listWorktrees(),
    git.listBranchesMatching(`${prefix}*`),
  ]);
  return [
    ...worktrees.filter((path) => isUnder(root, path)),
    ...branches.filter((branch) => branch.startsWith(prefix)),
  ];
}

function samePath(left: string, right: string): boolean {
  return canonical(left) === canonical(right);
}

function isUnder(root: string, path: string): boolean {
  const value = relative(canonical(root), canonical(path));
  return value.length > 0 && !value.startsWith("..") && !value.includes("../");
}

function canonical(path: string): string {
  let value: string;
  try {
    value = realpathSync(path);
  } catch {
    value = resolve(path);
  }
  return value.replace(/^\/private\/var\//, "/var/");
}

function manualRecovery(resource: string): Error {
  return new Error(
    `${resource}. Remove or recover it manually, then retry cleanup.`,
  );
}
