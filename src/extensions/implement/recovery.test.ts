import { describe, expect, it } from "vitest";
import { boundedRecoveryOutput, providerRetryDelayMs } from "./recovery.js";

describe("recovery utilities", () => {
  it("bounds retained process output and exponentially backs off provider retries", () => {
    expect(boundedRecoveryOutput("x".repeat(12_001))).toHaveLength(12_000);
    expect(providerRetryDelayMs(1)).toBe(1_000);
    expect(providerRetryDelayMs(3)).toBe(4_000);
    expect(providerRetryDelayMs(20)).toBe(60_000);
  });
});
