import { describe, expect, it } from "vitest";
import { boundedRecoveryOutput } from "./recovery.js";

describe("recovery utilities", () => {
  it("bounds retained process output", () => {
    expect(boundedRecoveryOutput("x".repeat(12_001))).toHaveLength(12_000);
  });
});
