import { describe, expect, it } from "vitest";
import {
  formatConfigStatus,
  getConfigPath,
  parseConfig,
  resolveEffectiveRoles,
  resolveMaxParallel,
  resolveEffectiveTaskReview,
  reviewerDefaultTypeWarning,
  resolveEffectiveScoutConfig,
} from "./config.js";

describe("config", () => {
  it("constructs the global config path", () => {
    expect(getConfigPath("/home/me/.pi/agent")).toBe(
      "/home/me/.pi/agent/extensions/pi-implement/config.json",
    );
  });

  it("parses valid role models and types", () => {
    expect(
      parseConfig(
        JSON.stringify({
          implementer: { model: "a/b", type: "general-purpose" },
          reviewer: { model: "c/d", type: "reviewer" },
        }),
      ).config,
    ).toEqual({
      implementer: { model: "a/b", type: "general-purpose" },
      reviewer: { model: "c/d", type: "reviewer" },
    });
  });

  it("parses maxParallel", () => {
    expect(parseConfig(JSON.stringify({ maxParallel: 5 })).config).toEqual({
      maxParallel: 5,
    });
  });

  it("clamps maxParallel to hard maximum", () => {
    expect(parseConfig(JSON.stringify({ maxParallel: 15 })).config).toEqual({
      maxParallel: 8,
    });
  });

  it("ignores invalid maxParallel with warning", () => {
    const parsed = parseConfig(JSON.stringify({ maxParallel: 0 }));
    expect(parsed.config).toEqual({});
    expect(parsed.warning).toContain("maxParallel");
  });

  it("parses verifyCommand", () => {
    expect(
      parseConfig(JSON.stringify({ verifyCommand: "npm test" })).config,
    ).toEqual({
      verifyCommand: "npm test",
    });
  });

  it("ignores empty verifyCommand with warning", () => {
    const parsed = parseConfig(JSON.stringify({ verifyCommand: "" }));
    expect(parsed.config).toEqual({});
    expect(parsed.warning).toContain("verifyCommand");
  });

  it("parses planner role", () => {
    expect(
      parseConfig(
        JSON.stringify({
          planner: { model: "e/f", type: "Explore" },
        }),
      ).config,
    ).toEqual({
      planner: { model: "e/f", type: "Explore" },
    });
  });

  it("falls back to default subagent types without forcing a model", () => {
    const result = resolveEffectiveRoles({}, {
      model: { provider: "p", id: "m" },
    } as never);
    expect(result).toEqual({
      ok: true,
      roles: {
        implementer: { model: undefined, type: "general-purpose" },
        reviewer: { model: undefined, type: "general-purpose" },
        planner: { model: undefined, type: "Explore" },
      },
    });
  });

  it("uses configured models when provided", () => {
    const result = resolveEffectiveRoles(
      {
        implementer: { model: "p/impl", type: "Implement" },
        reviewer: { model: "p/review" },
        planner: { model: "p/plan" },
      },
      {} as never,
    );
    expect(result).toEqual({
      ok: true,
      roles: {
        implementer: { model: "p/impl", type: "Implement" },
        reviewer: { model: "p/review", type: "general-purpose" },
        planner: { model: "p/plan", type: "Explore" },
      },
    });
  });

  it("resolves maxParallel with defaults", () => {
    expect(resolveMaxParallel({})).toBe(3);
    expect(resolveMaxParallel({ maxParallel: 6 })).toBe(6);
    expect(resolveMaxParallel({ maxParallel: 2 })).toBe(2);
    expect(resolveMaxParallel({ maxParallel: 10 })).toBe(8);
  });

  it("warns when reviewer uses the default general-purpose subagent", () => {
    expect(
      reviewerDefaultTypeWarning({
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
        planner: { model: "p/m", type: "Explore" },
      }),
    ).toContain("general-purpose");
    expect(
      reviewerDefaultTypeWarning({
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "review" },
        planner: { model: "p/m", type: "Explore" },
      }),
    ).toBeUndefined();
  });

  it("formats config status", () => {
    expect(
      formatConfigStatus({ path: "/x/config.json", config: {} }),
    ).toContain("Config: /x/config.json");
  });
});

describe("taskReview config", () => {
  it("defaults to auto mode with conservative thresholds", () => {
    const effective = resolveEffectiveTaskReview({});
    expect(effective.mode).toBe("auto");
    expect(effective.maxSkipDiffChars).toBe(2000);
    expect(effective.maxSkipFiles).toBe(3);
  });

  it("parses valid taskReview settings", () => {
    const parsed = parseConfig(
      JSON.stringify({
        taskReview: { mode: "always", maxSkipDiffChars: 500, maxSkipFiles: 1 },
      }),
    );
    expect(parsed.config.taskReview).toEqual({
      mode: "always",
      maxSkipDiffChars: 500,
      maxSkipFiles: 1,
    });
    expect(parsed.warning).toBeUndefined();
  });

  it("clamps maxSkipDiffChars to hard maximum", () => {
    const parsed = parseConfig(
      JSON.stringify({ taskReview: { maxSkipDiffChars: 50000 } }),
    );
    expect(parsed.config.taskReview?.maxSkipDiffChars).toBe(10000);
  });

  it("clamps maxSkipFiles to hard maximum", () => {
    const parsed = parseConfig(
      JSON.stringify({ taskReview: { maxSkipFiles: 50 } }),
    );
    expect(parsed.config.taskReview?.maxSkipFiles).toBe(10);
  });

  it("ignores invalid taskReview mode with warning", () => {
    const parsed = parseConfig(
      JSON.stringify({ taskReview: { mode: "sometimes" } }),
    );
    expect(parsed.config.taskReview).toEqual({});
    expect(parsed.warning).toContain("taskReview.mode");
  });

  it("ignores non-object taskReview with warning", () => {
    const parsed = parseConfig(JSON.stringify({ taskReview: "auto" }));
    expect(parsed.config.taskReview).toBeUndefined();
    expect(parsed.warning).toContain("taskReview must be an object");
  });

  it("ignores invalid maxSkipDiffChars with warning", () => {
    const parsed = parseConfig(
      JSON.stringify({ taskReview: { maxSkipDiffChars: 0 } }),
    );
    expect(parsed.config.taskReview).toEqual({});
    expect(parsed.warning).toContain("maxSkipDiffChars");
  });

  it("ignores invalid maxSkipFiles with warning", () => {
    const parsed = parseConfig(
      JSON.stringify({ taskReview: { maxSkipFiles: -1 } }),
    );
    expect(parsed.config.taskReview).toEqual({});
    expect(parsed.warning).toContain("maxSkipFiles");
  });

  it("includes task review mode and thresholds in status output", () => {
    const status = formatConfigStatus({
      path: "/x/config.json",
      config: { taskReview: { mode: "always", maxSkipDiffChars: 500 } },
    });
    expect(status).toContain("Task review mode: always");
    expect(status).toContain("Task review skip thresholds: 500 chars");
  });
});

describe("scout config", () => {
  it("defaults to enabled auto mode with Explore type", () => {
    const effective = resolveEffectiveScoutConfig({});
    expect(effective.enabled).toBe(true);
    expect(effective.mode).toBe("auto");
    expect(effective.type).toBe("Explore");
    expect(effective.model).toBeUndefined();
    expect(effective.maxResultChars).toBe(50000);
    expect(effective.timeoutMs).toBe(120000);
  });

  it("parses valid scout settings", () => {
    const parsed = parseConfig(
      JSON.stringify({
        scout: {
          enabled: false,
          mode: "always",
          type: "Explore",
          model: "p/scout",
          maxResultChars: 10000,
          timeoutMs: 30000,
        },
      }),
    );
    expect(parsed.config.scout).toEqual({
      enabled: false,
      mode: "always",
      type: "Explore",
      model: "p/scout",
      maxResultChars: 10000,
      timeoutMs: 30000,
    });
    expect(parsed.warning).toBeUndefined();
  });

  it("clamps maxResultChars to hard maximum", () => {
    const parsed = parseConfig(
      JSON.stringify({ scout: { maxResultChars: 500000 } }),
    );
    expect(parsed.config.scout?.maxResultChars).toBe(200000);
  });

  it("clamps timeoutMs to hard maximum", () => {
    const parsed = parseConfig(
      JSON.stringify({ scout: { timeoutMs: 1000000 } }),
    );
    expect(parsed.config.scout?.timeoutMs).toBe(600000);
  });

  it("ignores invalid scout mode with warning", () => {
    const parsed = parseConfig(
      JSON.stringify({ scout: { mode: "sometimes" } }),
    );
    expect(parsed.config.scout).toEqual({});
    expect(parsed.warning).toContain(
      'scout.mode must be "auto", "always", or "off"',
    );
  });

  it("ignores non-object scout with warning", () => {
    const parsed = parseConfig(JSON.stringify({ scout: "auto" }));
    expect(parsed.config.scout).toBeUndefined();
    expect(parsed.warning).toContain("scout must be an object");
  });

  it("ignores invalid scout.enabled with warning", () => {
    const parsed = parseConfig(JSON.stringify({ scout: { enabled: "yes" } }));
    expect(parsed.config.scout).toEqual({});
    expect(parsed.warning).toContain("scout.enabled must be a boolean");
  });

  it("ignores invalid scout.type with warning", () => {
    const parsed = parseConfig(JSON.stringify({ scout: { type: 123 } }));
    expect(parsed.config.scout).toEqual({});
    expect(parsed.warning).toContain("scout.type must be a string");
  });

  it("ignores empty scout.type with warning", () => {
    const parsed = parseConfig(JSON.stringify({ scout: { type: "  " } }));
    expect(parsed.config.scout).toEqual({});
    expect(parsed.warning).toContain("scout.type must be a non-empty string");
  });

  it("uses custom scout.type when provided", () => {
    const parsed = parseConfig(
      JSON.stringify({ scout: { type: "CustomScout" } }),
    );
    expect(parsed.config.scout?.type).toBe("CustomScout");
    const effective = resolveEffectiveScoutConfig(parsed.config);
    expect(effective.type).toBe("CustomScout");
  });

  it("ignores invalid scout.model with warning", () => {
    const parsed = parseConfig(JSON.stringify({ scout: { model: 123 } }));
    expect(parsed.config.scout).toEqual({});
    expect(parsed.warning).toContain("scout.model must be a string");
  });

  it("ignores empty scout.model with warning", () => {
    const parsed = parseConfig(JSON.stringify({ scout: { model: "  " } }));
    expect(parsed.config.scout).toEqual({});
    expect(parsed.warning).toContain("scout.model must be a non-empty string");
  });

  it("ignores invalid maxResultChars with warning", () => {
    const parsed = parseConfig(
      JSON.stringify({ scout: { maxResultChars: 0 } }),
    );
    expect(parsed.config.scout).toEqual({});
    expect(parsed.warning).toContain(
      "scout.maxResultChars must be a positive integer",
    );
  });

  it("ignores invalid timeoutMs with warning", () => {
    const parsed = parseConfig(JSON.stringify({ scout: { timeoutMs: -1 } }));
    expect(parsed.config.scout).toEqual({});
    expect(parsed.warning).toContain(
      "scout.timeoutMs must be a positive integer",
    );
  });

  it("includes scout status in formatConfigStatus", () => {
    const status = formatConfigStatus({
      path: "/x/config.json",
      config: {
        scout: { enabled: false, mode: "off", type: "Custom", model: "p/m" },
      },
    });
    expect(status).toContain("Scout enabled: false");
    expect(status).toContain("Scout mode: off");
    expect(status).toContain("Scout subagent: Custom");
    expect(status).toContain("Scout model: p/m");
    expect(status).toContain("Scout max result chars: 50000");
    expect(status).toContain("Scout timeout: 120000ms");
  });

  it("omits scout model line when no model is set", () => {
    const status = formatConfigStatus({
      path: "/x/config.json",
      config: {},
    });
    expect(status).toContain("Scout enabled: true");
    expect(status).toContain("Scout mode: auto");
    expect(status).toContain("Scout subagent: Explore");
    expect(status).not.toContain("Scout model:");
  });
});
