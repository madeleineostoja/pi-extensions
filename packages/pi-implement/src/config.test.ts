import { describe, expect, it } from "vitest";
import {
  formatConfigStatus,
  getConfigPath,
  parseConfig,
  resolveEffectiveRoles,
  resolveMaxParallel,
  reviewerDefaultTypeWarning,
} from "./config.js";

describe("config", () => {
  it("constructs the global config path", () => {
    expect(getConfigPath("/home/me/.pi/agent")).toBe(
      "/home/me/.pi/agent/extensions/pi-implement/config.json",
    );
  });

  it("parses valid role models, types, and thinking", () => {
    expect(
      parseConfig(
        JSON.stringify({
          implementer: {
            model: "a/b",
            type: "general-purpose",
            thinking: "high",
          },
          reviewer: { model: "c/d", type: "reviewer", thinking: "low" },
          selfHeal: { model: "e/f", thinking: "xhigh" },
        }),
      ).config,
    ).toEqual({
      implementer: {
        model: "a/b",
        type: "general-purpose",
        thinking: "high",
      },
      reviewer: { model: "c/d", type: "reviewer", thinking: "low" },
      selfHeal: { model: "e/f", thinking: "xhigh" },
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

  it("ignores removed scout config surface", () => {
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
    expect(parsed.config).toEqual({});
    expect(parsed.warning).toBeUndefined();
  });

  it("falls back to default subagent types without forcing a model", () => {
    const result = resolveEffectiveRoles({}, {
      model: { provider: "p", id: "m" },
    } as never);
    expect(result).toEqual({
      ok: true,
      roles: {
        implementer: {
          model: undefined,
          type: "general-purpose",
          thinking: undefined,
        },
        reviewer: {
          model: undefined,
          type: "general-purpose",
          thinking: undefined,
        },
        planner: { model: undefined, type: "Explore", thinking: undefined },
        selfHeal: {
          model: undefined,
          type: "general-purpose",
          thinking: undefined,
        },
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
        implementer: {
          model: "p/impl",
          type: "Implement",
          thinking: undefined,
        },
        reviewer: {
          model: "p/review",
          type: "general-purpose",
          thinking: undefined,
        },
        planner: { model: "p/plan", type: "Explore", thinking: undefined },
        selfHeal: {
          model: "p/impl",
          type: "general-purpose",
          thinking: undefined,
        },
      },
    });
  });

  it("inherits implementer model and thinking for self-heal by default", () => {
    const result = resolveEffectiveRoles(
      {
        implementer: { model: "p/impl", thinking: "high" },
        selfHeal: { thinking: "low" },
      },
      {} as never,
    );

    expect(result).toEqual({
      ok: true,
      roles: expect.objectContaining({
        selfHeal: {
          model: "p/impl",
          type: "general-purpose",
          thinking: "low",
        },
      }),
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
        selfHeal: { model: "p/m", type: "general-purpose" },
      }),
    ).toContain("general-purpose");
    expect(
      reviewerDefaultTypeWarning({
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "review" },
        planner: { model: "p/m", type: "Explore" },
        selfHeal: { model: "p/m", type: "general-purpose" },
      }),
    ).toBeUndefined();
  });

  it("formats config status without scout lines", () => {
    const status = formatConfigStatus({
      path: "/x/config.json",
      config: {
        implementer: { thinking: "high" },
        reviewer: { thinking: "low" },
        planner: { thinking: "medium" },
        selfHeal: { thinking: "xhigh" },
      },
    });
    expect(status).toContain("Config: /x/config.json");
    expect(status).toContain("Implementer thinking: high");
    expect(status).toContain("Reviewer thinking: low");
    expect(status).toContain("Planner thinking: medium");
    expect(status).toContain("Self-heal thinking: xhigh");
    expect(status).not.toContain("Scout");
    expect(status).not.toContain("Task review");
    expect(status).not.toContain("skip thresholds");
  });

  it("ignores removed taskReview config surface", () => {
    const parsed = parseConfig(
      JSON.stringify({
        taskReview: { mode: "always", maxSkipDiffChars: 500, maxSkipFiles: 1 },
      }),
    );
    expect(parsed.config).toEqual({});
    expect(parsed.warning).toBeUndefined();
  });

  it("does not include task review mode or thresholds in status output", () => {
    const status = formatConfigStatus({
      path: "/x/config.json",
      config: {},
    });
    expect(status).not.toContain("Task review mode");
    expect(status).not.toContain("Task review skip thresholds");
    expect(status).not.toContain("maxSkipDiffChars");
    expect(status).not.toContain("maxSkipFiles");
  });
});
