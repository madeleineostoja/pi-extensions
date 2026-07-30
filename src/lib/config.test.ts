import { describe, expect, it } from "vitest";
import { getConfigPath, parsePipkinConfig, presetIssue } from "./config.ts";

const models = {
  utility: { model: "test/utility", thinking: "minimal" },
  low: { model: "test/low", thinking: "low" },
  medium: { model: "test/medium", thinking: "medium" },
  high: { model: "test/high", thinking: "high" },
};

describe("Pipkin config", () => {
  it("uses the sole agent-level config path", () => {
    expect(getConfigPath("/agent")).toBe("/agent/pipkin/config.json");
  });

  it("keeps valid sections when a sibling preset is invalid", () => {
    const snapshot = parsePipkinConfig(
      JSON.stringify({
        models: { ...models, utility: { model: "bad", thinking: "minimal" } },
        implement: { workerConcurrency: 99 },
        unsupported: { enabled: false },
      }),
    );

    expect(snapshot.config.models.utility).toBeUndefined();
    expect(snapshot.config.models.low).toEqual(models.low);
    expect(snapshot.config.implement.workerConcurrency).toBe(8);
    expect(snapshot.config).not.toHaveProperty("unsupported");
    expect(snapshot.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "unsupported" }),
      ]),
    );
    expect(presetIssue(snapshot, "utility")?.message).toContain("model");
  });

  it("reports missing and unknown model fields without substituting a preset", () => {
    const snapshot = parsePipkinConfig(
      JSON.stringify({
        models: {
          utility: models.utility,
          low: { model: "test/low", thinking: "nope" },
          high: { ...models.high, extra: true },
          extra: models.medium,
        },
        implement: { workerConcurrency: 0 },
      }),
    );

    expect(snapshot.config.models.low).toBeUndefined();
    expect(snapshot.config.models.medium).toBeUndefined();
    expect(snapshot.config.models.high).toBeUndefined();
    expect(presetIssue(snapshot, "high")?.path).toBe("models.high.extra");
    expect(snapshot.config.implement.workerConcurrency).toBe(3);
    expect(snapshot.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "models.low",
        "models.medium",
        "models.high.extra",
        "models.extra",
        "implement.workerConcurrency",
      ]),
    );
  });

  it("rejects removed context policy configuration", () => {
    const snapshot = parsePipkinConfig(
      JSON.stringify({ models, context: { staleTurns: 6 } }),
    );

    expect(snapshot.config).not.toHaveProperty("context");
    expect(snapshot.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "context",
          message: "is not supported",
        }),
      ]),
    );
  });

  it("reports malformed JSON and returns an immutable snapshot", () => {
    const snapshot = parsePipkinConfig("{ nope");
    expect(snapshot.issues[0]?.message).toContain("malformed JSON");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.config.models)).toBe(true);
  });
});
