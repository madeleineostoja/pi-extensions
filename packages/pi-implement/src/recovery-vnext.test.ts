import { describe, expect, it } from "vitest";
import {
  advanceNoActionCycle,
  boundedRecoveryOutput,
  providerRetryDelayMs,
  recoveryCycleSignature,
} from "./recovery-vnext.js";

describe("VNext recovery cycles", () => {
  it("escalates one repeated no-action cycle and pauses the next identical one", () => {
    const initial = {
      signature: "same",
      identicalNoActionCycles: 0,
      independentlyEscalated: false,
    };
    const escalation = advanceNoActionCycle({
      cycle: initial,
      signature: "same",
    });
    const pause = advanceNoActionCycle({
      cycle: escalation.cycle,
      signature: "same",
    });

    expect(escalation.disposition).toBe("escalate");
    expect(escalation.cycle.independentlyEscalated).toBe(true);
    expect(pause.disposition).toBe("pause");
  });

  it("resets the no-action cycle when failure evidence changes", () => {
    const signature = recoveryCycleSignature({
      gateId: "review:workstream",
      candidateTree: "tree",
      failureEvidence: "missing dependency",
      outstandingFindings: [{ id: "finding-1", evidence: "module absent" }],
      workspaceId: "source:workstream",
      nextAction: "no_safe_action",
    });
    const changed = recoveryCycleSignature({
      gateId: "review:workstream",
      candidateTree: "tree",
      failureEvidence: "different failing command",
      outstandingFindings: [{ id: "finding-1", evidence: "module absent" }],
      workspaceId: "source:workstream",
      nextAction: "no_safe_action",
    });
    const result = advanceNoActionCycle({
      cycle: {
        signature,
        identicalNoActionCycles: 1,
        independentlyEscalated: true,
      },
      signature: changed,
    });

    expect(result.disposition).toBe("continue");
    expect(result.cycle).toMatchObject({
      signature: changed,
      identicalNoActionCycles: 0,
      independentlyEscalated: false,
    });
  });

  it("bounds retained process output and exponentially backs off provider retries", () => {
    expect(boundedRecoveryOutput("x".repeat(12_001))).toHaveLength(12_000);
    expect(providerRetryDelayMs(1)).toBe(1_000);
    expect(providerRetryDelayMs(3)).toBe(4_000);
    expect(providerRetryDelayMs(20)).toBe(60_000);
  });
});
