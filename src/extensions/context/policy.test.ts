import { describe, expect, it } from "vitest";
import { isEpochData } from "./policy.ts";

function epoch(estimatedTokensSaved?: unknown) {
  return {
    kind: "tail",
    decisions: [
      {
        sourceToolCallId: "source",
        reason: "standard-stale",
        stub: '[tool result elided. Call context_recall("source") to retrieve.]',
        ...(estimatedTokensSaved === undefined ? {} : { estimatedTokensSaved }),
      },
    ],
  };
}

describe("Context epoch schema", () => {
  it("accepts legacy v1 decisions without savings byte-identically", () => {
    const legacy = epoch();
    const replay = JSON.parse(JSON.stringify(legacy));

    expect(isEpochData(legacy)).toBe(true);
    expect(replay).toEqual(legacy);
  });

  it("requires present savings to be a positive safe integer", () => {
    for (const value of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "1",
    ]) {
      expect(isEpochData(epoch(value))).toBe(false);
    }
    expect(isEpochData(epoch(1))).toBe(true);
  });

  it("retains strict unknown-key validation", () => {
    expect(
      isEpochData({
        ...epoch(1),
        decisions: [{ ...epoch(1).decisions[0], unexpected: true }],
      }),
    ).toBe(false);
  });
});
