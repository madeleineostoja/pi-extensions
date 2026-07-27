import { describe, expect, it, vi } from "vitest";
import { DEFAULTS, defaultConfig, resolveConfig } from "./config.ts";

describe("resolveConfig", () => {
  it("uses defaults when the shared Context section is absent", () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULTS);
  });

  it("applies valid Context overrides", () => {
    expect(
      resolveConfig({
        staleTurns: 7,
        minTokens: 512,
        duplicateReadsEnabled: false,
        batchMaxSemanticRisk: 2.5,
      }),
    ).toMatchObject({
      staleTurns: 7,
      minTokens: 512,
      duplicateReadsEnabled: false,
      batchMaxSemanticRisk: 2.5,
    });
  });

  it("keeps valid siblings when one override is invalid", () => {
    const notify = vi.fn();
    expect(
      resolveConfig(
        { staleTurns: "many", minTokens: 512, coveredReadsEnabled: "yes" },
        notify,
      ),
    ).toMatchObject({
      staleTurns: DEFAULTS.staleTurns,
      minTokens: 512,
      coveredReadsEnabled: DEFAULTS.coveredReadsEnabled,
    });
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe("defaultConfig", () => {
  it("returns a fresh copy", () => {
    const config = defaultConfig();
    config.staleTurns = 99;
    expect(defaultConfig().staleTurns).toBe(DEFAULTS.staleTurns);
  });
});
