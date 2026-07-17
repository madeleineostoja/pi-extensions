import type {
  ReviewConvergenceState,
  ReviewFinding,
} from "./review-convergence.js";

export type IntegrationGateKind = "apply" | "validator" | "hook" | "fallback";

export type IntegrationGate = {
  key: string;
  kind: IntegrationGateKind;
  label: string;
};

export type IntegrationLedger = {
  idPrefix: string;
  epoch: number;
  mainBaseSha: string;
  gateSet: string[];
  gates: IntegrationGate[];
  findings: ReviewFinding[];
  outstandingIds: string[];
  gateFindingIds: Record<string, string[]>;
  bestOutstandingCount: number;
  consecutiveStalledRounds: number;
  fallbackReview?: ReviewConvergenceState;
  fallbackCandidateFingerprint?: string;
  fallbackCandidatePatch?: string;
};

export type IntegrationLedgerOutcome = "approved" | "continue" | "stalled";

export function createIntegrationLedger(args: {
  epoch?: number;
  mainBaseSha: string;
  gates: IntegrationGate[];
  idPrefix?: string;
}): IntegrationLedger {
  const idPrefix = args.idPrefix ?? "I";
  const findings = args.gates.map((gate, index) => ({
    id: `${idPrefix}${index + 1}`,
    summary: gate.label,
    evidence: "Not yet assessed.",
    requiredChange: `Make the ${gate.label} gate pass.`,
    acceptanceCriteria: [`${gate.label} passes when rerun.`],
    introducedRound: 0,
    origin: "initial" as const,
  }));
  return {
    idPrefix,
    epoch: args.epoch ?? 1,
    mainBaseSha: args.mainBaseSha,
    gateSet: args.gates.map(integrationGateSignature),
    gates: args.gates,
    findings,
    outstandingIds: findings.map((finding) => finding.id),
    gateFindingIds: Object.fromEntries(
      args.gates.map((gate, index) => [gate.key, [`${idPrefix}${index + 1}`]]),
    ),
    bestOutstandingCount: findings.length,
    consecutiveStalledRounds: 0,
  };
}

export function integrationGateId(
  ledger: IntegrationLedger,
  key: string,
): string | undefined {
  return integrationGateIds(ledger, key)[0];
}

function integrationGateIds(ledger: IntegrationLedger, key: string): string[] {
  const persisted = ledger.gateFindingIds?.[key];
  if (persisted?.length) {
    return persisted;
  }
  const index = ledger.gates.findIndex((gate) => gate.key === key);
  return index < 0 ? [] : [`${ledger.idPrefix ?? "I"}${index + 1}`];
}

export function reassessIntegrationGate(args: {
  ledger: IntegrationLedger;
  key: string;
  passed: boolean;
  evidence: string;
}): { ledger: IntegrationLedger; outcome: IntegrationLedgerOutcome } {
  const gateIds = integrationGateIds(args.ledger, args.key);
  if (gateIds.length === 0) {
    throw new Error(`Unknown integration gate: ${args.key}`);
  }
  const outstandingForGate = gateIds.filter((id) =>
    args.ledger.outstandingIds.includes(id),
  );
  let findings = args.ledger.findings.map((finding) =>
    gateIds.includes(finding.id)
      ? { ...finding, evidence: args.evidence }
      : finding,
  );
  let outstandingIds = [...args.ledger.outstandingIds];
  let gateFindingIds = { ...args.ledger.gateFindingIds };

  if (args.passed) {
    outstandingIds = outstandingIds.filter((id) => !gateIds.includes(id));
  } else if (outstandingForGate.length === 0) {
    const regressionId = `${args.ledger.idPrefix ?? "I"}${nextFindingNumber(findings, args.ledger.idPrefix ?? "I")}`;
    const original = findings.find((finding) => finding.id === gateIds[0])!;
    findings = [
      ...findings,
      {
        ...original,
        id: regressionId,
        evidence: args.evidence,
        introducedRound: original.introducedRound + 1,
        origin: "regression",
      },
    ];
    outstandingIds.push(regressionId);
    gateFindingIds = {
      ...gateFindingIds,
      [args.key]: [...gateIds, regressionId],
    };
  }

  const ledger = { ...args.ledger, findings, outstandingIds, gateFindingIds };
  return {
    ledger,
    outcome: outstandingIds.length === 0 ? "approved" : "continue",
  };
}

export function completeIntegrationRound(ledger: IntegrationLedger): {
  ledger: IntegrationLedger;
  outcome: IntegrationLedgerOutcome;
} {
  const outstandingCount = ledger.outstandingIds.length;
  const hasNewLow = outstandingCount < ledger.bestOutstandingCount;
  const next = {
    ...ledger,
    bestOutstandingCount: hasNewLow
      ? outstandingCount
      : ledger.bestOutstandingCount,
    consecutiveStalledRounds: hasNewLow
      ? 0
      : ledger.consecutiveStalledRounds + 1,
  };
  return {
    ledger: next,
    outcome:
      outstandingCount === 0
        ? "approved"
        : next.consecutiveStalledRounds >= 2
          ? "stalled"
          : "continue",
  };
}

export function recordIntegrationStall(ledger: IntegrationLedger): {
  ledger: IntegrationLedger;
  outcome: Exclude<IntegrationLedgerOutcome, "approved">;
} {
  const result = completeIntegrationRound(ledger);
  return {
    ledger: result.ledger,
    outcome: result.outcome === "approved" ? "continue" : result.outcome,
  };
}

export function sameIntegrationPipeline(
  ledger: IntegrationLedger | undefined,
  mainBaseSha: string,
  gates: readonly IntegrationGate[],
): boolean {
  return Boolean(
    ledger &&
    ledger.mainBaseSha === mainBaseSha &&
    ledger.gateSet.length === gates.length &&
    ledger.gateSet.every(
      (signature, index) =>
        signature === integrationGateSignature(gates[index]!),
    ),
  );
}

function integrationGateSignature(gate: IntegrationGate): string {
  return `${gate.key}\u0000${gate.kind}\u0000${gate.label}`;
}

function nextFindingNumber(
  findings: readonly ReviewFinding[],
  prefix: string,
): number {
  return (
    findings.reduce((highest, finding) => {
      const value = Number(finding.id.slice(prefix.length));
      return Number.isSafeInteger(value) ? Math.max(highest, value) : highest;
    }, 0) + 1
  );
}
