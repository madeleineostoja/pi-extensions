import { describe, expect, it } from "vitest";
import {
  createIntegrationLedger,
  completeIntegrationRound,
  reassessIntegrationGate,
  sameIntegrationPipeline,
} from "./integration-ledger.js";

const gates = [
  { key: "apply", kind: "apply" as const, label: "Apply candidate" },
  { key: "validator:0", kind: "validator" as const, label: "Validate" },
  { key: "hook", kind: "hook" as const, label: "Run hook" },
];

describe("integration ledger", () => {
  it("predeclares ordered obligations and lowers the low-water mark as gates become reachable", () => {
    let ledger = createIntegrationLedger({ mainBaseSha: "base", gates });
    expect(ledger.outstandingIds).toEqual(["I1", "I2", "I3"]);

    ledger = reassessIntegrationGate({
      ledger,
      key: "apply",
      passed: true,
      evidence: "applied",
    }).ledger;
    expect(ledger.outstandingIds).toEqual(["I2", "I3"]);
    ledger = completeIntegrationRound(ledger).ledger;
    expect(ledger.bestOutstandingCount).toBe(2);

    ledger = reassessIntegrationGate({
      ledger,
      key: "validator:0",
      passed: true,
      evidence: "validated",
    }).ledger;
    const hook = reassessIntegrationGate({
      ledger,
      key: "hook",
      passed: true,
      evidence: "hook passed",
    });
    expect(hook.outcome).toBe("approved");
  });

  it("supports a distinct stable prefix for overall integration obligations", () => {
    let ledger = createIntegrationLedger({
      mainBaseSha: "base",
      gates,
      idPrefix: "OI",
    });
    expect(ledger.outstandingIds).toEqual(["OI1", "OI2", "OI3"]);
    ledger = reassessIntegrationGate({
      ledger,
      key: "apply",
      passed: true,
      evidence: "applied",
    }).ledger;
    ledger = reassessIntegrationGate({
      ledger,
      key: "apply",
      passed: false,
      evidence: "regressed",
    }).ledger;
    expect(ledger.outstandingIds).toEqual(["OI2", "OI3", "OI4"]);
  });

  it("allocates monotonic regression IDs without resetting the low-water baseline", () => {
    let ledger = createIntegrationLedger({ mainBaseSha: "base", gates });
    ledger = reassessIntegrationGate({
      ledger,
      key: "apply",
      passed: true,
      evidence: "applied",
    }).ledger;
    ledger = reassessIntegrationGate({
      ledger,
      key: "validator:0",
      passed: true,
      evidence: "validated",
    }).ledger;
    ledger = reassessIntegrationGate({
      ledger,
      key: "hook",
      passed: true,
      evidence: "hook passed",
    }).ledger;

    const regression = reassessIntegrationGate({
      ledger,
      key: "validator:0",
      passed: false,
      evidence: "regressed",
    });
    expect(regression.ledger.outstandingIds).toEqual(["I4"]);
    const resolved = reassessIntegrationGate({
      ledger: regression.ledger,
      key: "validator:0",
      passed: true,
      evidence: "repaired",
    });
    expect(resolved.ledger.outstandingIds).toEqual([]);
    expect(resolved.ledger.gateFindingIds["validator:0"]).toEqual(["I2", "I4"]);
    const round = completeIntegrationRound(resolved.ledger);
    expect(round.ledger.bestOutstandingCount).toBe(0);
    expect(round.ledger.consecutiveStalledRounds).toBe(0);
  });

  it("counts stalls once per pipeline round rather than once per gate", () => {
    let ledger = createIntegrationLedger({ mainBaseSha: "base", gates });
    ledger = reassessIntegrationGate({
      ledger,
      key: "apply",
      passed: false,
      evidence: "conflict",
    }).ledger;
    ledger = reassessIntegrationGate({
      ledger,
      key: "validator:0",
      passed: false,
      evidence: "blocked",
    }).ledger;
    expect(ledger.consecutiveStalledRounds).toBe(0);
    expect(
      completeIntegrationRound(ledger).ledger.consecutiveStalledRounds,
    ).toBe(1);
  });

  it("starts a new pipeline only when its main base or declared gate set changes", () => {
    const ledger = createIntegrationLedger({ mainBaseSha: "base", gates });
    expect(sameIntegrationPipeline(ledger, "base", gates)).toBe(true);
    expect(sameIntegrationPipeline(ledger, "next-base", gates)).toBe(false);
    expect(sameIntegrationPipeline(ledger, "base", gates.slice(0, 2))).toBe(
      false,
    );
    expect(
      sameIntegrationPipeline(ledger, "base", [
        gates[0]!,
        { ...gates[1]!, label: "Changed validator command" },
        gates[2]!,
      ]),
    ).toBe(false);
  });
});
