import {
  changedPathsBetween,
  type GitClient,
  type GitStatusEntry,
} from "./git.js";

export type CandidateAdmissionInput = Readonly<{
  operationId: string;
  expectedBranch: string;
  requiredAncestors: readonly string[];
  comparisonBase: string;
  protectedPaths: readonly string[];
  targetBoundaryIntact: boolean;
}>;

export type CandidateWorkspaceObservation = Readonly<{
  branch: string;
  head: string;
  tree?: string;
  clean: boolean;
  activeOperation?: string;
  status: readonly GitStatusEntry[];
}>;

export type CandidateAdmission =
  | {
      kind: "admitted";
      observation: CandidateWorkspaceObservation;
      changedPaths: string[];
    }
  | {
      kind: "unchanged" | "quarantined" | "unsafe";
      observation: CandidateWorkspaceObservation;
      reason: string;
    };

export async function observeCandidateWorkspace(
  git: GitClient,
): Promise<CandidateWorkspaceObservation> {
  const [branch, head, activeOperation, status] = await Promise.all([
    git.currentBranch(),
    git.head(),
    git.activeOperation(),
    git.statusEntriesExcept([]),
  ]);
  const clean = status.length === 0;
  return {
    branch,
    head,
    clean,
    activeOperation,
    status,
    ...(clean ? { tree: await git.treeAt(head) } : {}),
  };
}

export async function admitCandidateWorkspace(args: {
  input: CandidateAdmissionInput;
  observation: CandidateWorkspaceObservation;
  git: GitClient;
}): Promise<CandidateAdmission> {
  const { input, observation, git } = args;
  if (!input.targetBoundaryIntact) {
    return { kind: "unsafe", observation, reason: "target boundary changed" };
  }
  if (observation.branch !== input.expectedBranch) {
    return { kind: "unsafe", observation, reason: "owned branch changed" };
  }
  if (observation.activeOperation) {
    return { kind: "unsafe", observation, reason: "Git operation is active" };
  }
  if (!observation.clean) {
    return { kind: "quarantined", observation, reason: "workspace is dirty" };
  }
  if (observation.head === input.comparisonBase) {
    return { kind: "unchanged", observation, reason: "candidate is unchanged" };
  }
  if (
    !(
      await Promise.all(
        input.requiredAncestors.map((ancestor) =>
          git.isAncestor(ancestor, observation.head),
        ),
      )
    ).every(Boolean)
  ) {
    return {
      kind: "unsafe",
      observation,
      reason: "required ancestry is missing",
    };
  }
  const [expectedTree, changedPaths] = await Promise.all([
    git.treeAt(observation.head),
    changedPathsBetween(git, input.comparisonBase, observation.head),
  ]);
  if (!observation.tree || observation.tree !== expectedTree) {
    return {
      kind: "unsafe",
      observation,
      reason: "candidate tree is inconsistent",
    };
  }
  if (changedPaths.some((path) => input.protectedPaths.includes(path))) {
    return {
      kind: "unsafe",
      observation,
      reason: "candidate changes protected paths",
    };
  }
  return { kind: "admitted", observation, changedPaths };
}
