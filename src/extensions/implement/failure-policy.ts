export const failureCategories = [
  "protocol_failure",
  "provider_failure",
  "semantic_blocked",
  "workspace_unsafe",
  "hook_rejected",
  "target_moved",
  "publication_uncertain",
  "persistence_runtime_failure",
  "dependency_skipped",
] as const;
export type FailureCategory = (typeof failureCategories)[number];

export const failureAssignmentKinds = [
  "candidate_revision",
  "failed_target_reconciliation",
  "review_retry",
  "workspace_recreation",
  "operational_retry",
  "blocked",
  "dependency_skip",
] as const;
export type FailureAssignmentKind = (typeof failureAssignmentKinds)[number];

export type FailureCommandEvidence = {
  command: string;
  cwd: string;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  output: string;
};

export function boundedFailureOutput(output: string, limit = 12_000): string {
  return output.length <= limit ? output : output.slice(-limit);
}
