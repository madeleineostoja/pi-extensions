import { describe, expect, it } from "vitest";
import {
  formatConfigStatus,
  getConfigPath,
  parseConfig,
  resolveEffectiveRoles,
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

  it("treats invalid json as empty config with warning", () => {
    const parsed = parseConfig("{");
    expect(parsed.config).toEqual({});
    expect(parsed.warning).toContain("Could not parse");
  });

  it("falls back to the current session model and default subagent type", () => {
    const result = resolveEffectiveRoles({}, {
      model: { provider: "p", id: "m" },
    } as never);
    expect(result).toEqual({
      ok: true,
      roles: {
        implementer: { model: "p/m", type: "general-purpose" },
        reviewer: { model: "p/m", type: "general-purpose" },
      },
    });
  });

  it("formats config status", () => {
    expect(
      formatConfigStatus({ path: "/x/config.json", config: {} }),
    ).toContain("Config: /x/config.json");
  });
});
