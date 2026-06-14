import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getPublicConfigPath,
  loadPublicConfig,
  parsePublicConfig,
  resolvePublicConfig,
} from "./config.js";

describe("public pi-subagents config", () => {
  it("constructs the public config path", () => {
    expect(getPublicConfigPath("/home/me")).toBe(
      "/home/me/.pi/agent/extensions/pi-subagents/config.json",
    );
  });

  it("parses optional models and thinking for public builtin types", () => {
    const parsed = parsePublicConfig(
      JSON.stringify({
        models: { General: "p/general", Explore: "p/explore" },
        thinking: { General: "off", Explore: "high", Review: "xhigh" },
      }),
    );

    expect(parsed.warnings).toEqual([]);
    expect(parsed.config).toEqual({
      models: { General: "p/general", Explore: "p/explore" },
      thinking: { General: "off", Explore: "high", Review: "xhigh" },
    });
  });

  it("warns on invalid entries and exposes resolved defaults", () => {
    const parsed = parsePublicConfig(
      JSON.stringify({
        models: { General: "", Unknown: "p/unknown" },
        thinking: { General: "medium", Explore: "maximum", Unknown: "low" },
      }),
    );

    expect(parsed.config).toEqual({
      models: {},
      thinking: { General: "medium" },
    });
    expect(parsed.warnings).toEqual([
      "Ignoring invalid model for General",
      "Ignoring model for unknown public subagent Unknown",
      "Ignoring invalid thinking level for Explore",
      "Ignoring thinking level for unknown public subagent Unknown",
    ]);
    expect(resolvePublicConfig(parsed.config)).toEqual({
      models: { General: undefined, Explore: undefined, Review: undefined },
      thinking: { General: "medium", Explore: "medium", Review: "medium" },
    });
  });

  it("loads config from disk and emits warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        models: { Review: "p/review" },
        thinking: { Review: "low" },
      }),
    );
    const warnings: string[] = [];

    try {
      expect(
        loadPublicConfig({ path, warn: (message) => warnings.push(message) }),
      ).toEqual({
        models: { General: undefined, Explore: undefined, Review: "p/review" },
        thinking: { General: "medium", Explore: "medium", Review: "low" },
      });
      expect(warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
