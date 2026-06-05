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
    expect(resolveMaxParallel({}, 5)).toBe(3);
    expect(resolveMaxParallel({ maxParallel: 6 }, 10)).toBe(6);
    expect(resolveMaxParallel({ maxParallel: 2 }, 10)).toBe(2);
    expect(resolveMaxParallel({ maxParallel: 10 }, 10)).toBe(8);
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
