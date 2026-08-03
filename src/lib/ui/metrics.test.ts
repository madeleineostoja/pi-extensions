import { describe, expect, it } from "vitest";
import {
  formatCompactTokens,
  formatDuration,
  formatProgress,
  formatUsdCost,
} from "./metrics.js";

describe("metric formatting", () => {
  it("preserves compact token and USD rounding", () => {
    expect(formatCompactTokens(9_999)).toBe("10.0k");
    expect(formatCompactTokens(10_000)).toBe("10k");
    expect(formatUsdCost(0.005)).toBe("$0.01");
  });

  it("formats elapsed duration and completed progress without runtime state", () => {
    expect(formatDuration(59_600)).toBe("1m 0s");
    expect(formatDuration(3_661_000)).toBe("1h 1m");
    expect(formatProgress(3, 8)).toBe("3/8");
  });
});
