import { createHash } from "node:crypto";

export const recoveryGateKinds = [
  "review",
  "environment",
  "hook",
  "reconciliation",
  "target",
  "whole_plan",
] as const;
export type RecoveryGateKind = (typeof recoveryGateKinds)[number];

export const recoveryActionKinds = [
  "diagnose",
  "retry",
  "rework_candidate",
  "reconcile",
  "recreate_workspace",
  "no_safe_action",
] as const;
export type RecoveryActionKind = (typeof recoveryActionKinds)[number];

export type RecoveryActionOutcome =
  | "completed"
  | "interrupted"
  | "execution_failure"
  | "no_safe_action";

export type RecoveryGateResult = {
  id: string;
  kind: RecoveryGateKind;
  owner: string;
  candidateId?: string;
  attempt: number;
  outcome: "passed" | "failed";
  evidence: string;
  command?: RecoveryCommandEvidence;
  targetEvidence?: string;
  outstandingFindingIds: string[];
};

export type RecoveryCommandEvidence = {
  command: string;
  cwd: string;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  output: string;
};

export type RecoveryAction = {
  kind: RecoveryActionKind;
  outcome: RecoveryActionOutcome;
  summary: string;
  evidence: string;
  at: string;
};

export type RecoveryCycle = {
  signature: string;
  identicalNoActionCycles: number;
  independentlyEscalated: boolean;
};

export function boundedRecoveryOutput(output: string, limit = 12_000): string {
  return output.length <= limit ? output : output.slice(-limit);
}

export function recoveryCycleSignature(args: {
  gateId: string;
  candidateTree?: string;
  failureEvidence: string;
  diagnosis?: string;
  workspaceEvidence?: string;
  outstandingFindings: Array<{ id: string; evidence: string }>;
  workspaceId: string;
  nextAction: RecoveryActionKind;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        gateId: args.gateId,
        candidateTree: args.candidateTree ?? "",
        failureEvidence: normalize(args.failureEvidence),
        diagnosis: normalize(args.diagnosis ?? ""),
        workspaceEvidence: normalize(args.workspaceEvidence ?? ""),
        outstandingFindings: [...args.outstandingFindings]
          .map((finding) => ({
            id: finding.id,
            evidence: normalize(finding.evidence),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        workspaceId: args.workspaceId,
        nextAction: args.nextAction,
      }),
    )
    .digest("hex");
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
