import { describe, expect, it } from "vitest";
import { parseConfig, getConfigPath } from "./config.js";

describe("getConfigPath", () => {
  it("returns the pi-subagents config path under agentDir", () => {
    expect(getConfigPath("/home/user/.pi/agent")).toBe(
      "/home/user/.pi/agent/extensions/pi-subagents/config.json",
    );
  });
});

describe("parseConfig", () => {
  it("parses a valid model map", () => {
    const result = parseConfig(
      JSON.stringify({
        models: {
          General: "openai/gpt-4",
          Explore: "anthropic/claude-sonnet",
          Review: "openai/gpt-5",
        },
      }),
    );
    expect(result.config.models).toEqual({
      General: "openai/gpt-4",
      Explore: "anthropic/claude-sonnet",
      Review: "openai/gpt-5",
    });
    expect(result.warning).toBeUndefined();
  });

  it("ignores invalid fields with warning", () => {
    const result = parseConfig(
      JSON.stringify({
        models: { General: "openai/gpt-4" },
        thinking: "high",
        maxTurns: 10,
      }),
    );
    expect(result.config.models).toEqual({ General: "openai/gpt-4" });
    expect(result.warning).toContain('unknown field "thinking"');
    expect(result.warning).toContain('unknown field "maxTurns"');
  });

  it("ignores invalid model entries", () => {
    const result = parseConfig(
      JSON.stringify({
        models: {
          General: "openai/gpt-4",
          Explore: "",
          Review: 123,
        },
      }),
    );
    expect(result.config.models).toEqual({ General: "openai/gpt-4" });
    expect(result.warning).toContain(
      'models["Explore"] must be a non-empty string',
    );
    expect(result.warning).toContain(
      'models["Review"] must be a non-empty string',
    );
  });

  it("returns empty config when models is not an object", () => {
    const result = parseConfig(JSON.stringify({ models: ["a", "b"] }));
    expect(result.config.models).toBeUndefined();
    expect(result.warning).toContain("models must be an object");
  });

  it("returns empty config and warning for non-object JSON", () => {
    const result = parseConfig(JSON.stringify([1, 2, 3]));
    expect(result.config).toEqual({});
    expect(result.warning).toBe("Config must be a JSON object; ignoring it.");
  });

  it("returns empty config and warning for invalid JSON", () => {
    const result = parseConfig("not json");
    expect(result.config).toEqual({});
    expect(result.warning).toMatch(/Could not parse config JSON/);
  });
});
