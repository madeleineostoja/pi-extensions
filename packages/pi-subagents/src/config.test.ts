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

  it("parses optional model and thinking for public builtin agent types", () => {
    const parsed = parsePublicConfig(
      JSON.stringify({
        agents: {
          General: { model: "p/general", thinking: "off" },
          Explore: { model: "p/explore", thinking: "high" },
          Review: { thinking: "xhigh" },
        },
      }),
    );

    expect(parsed.warnings).toEqual([]);
    expect(parsed.config).toEqual({
      agents: {
        General: { model: "p/general", thinking: "off" },
        Explore: { model: "p/explore", thinking: "high" },
        Review: { thinking: "xhigh" },
      },
    });
  });

  it("warns on invalid entries and leaves missing values unresolved", () => {
    const parsed = parsePublicConfig(
      JSON.stringify({
        agents: {
          General: { model: "", thinking: "medium" },
          Explore: { thinking: "maximum" },
          Review: "p/review",
          Unknown: { model: "p/unknown", thinking: "low" },
        },
      }),
    );

    expect(parsed.config).toEqual({
      agents: {
        General: { thinking: "medium" },
        Explore: {},
      },
    });
    expect(parsed.warnings).toEqual([
      "General.model must be a non-empty string",
      "Explore.thinking must be one of off, minimal, low, medium, high, xhigh",
      "Review config must be an object",
      "Ignoring config for unknown public subagent Unknown",
    ]);
    expect(resolvePublicConfig(parsed.config)).toEqual({
      agents: {
        General: { thinking: "medium" },
        Explore: {},
        Review: {},
      },
    });
  });

  it("loads config from disk and emits warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        agents: { Review: { model: "p/review", thinking: "low" } },
      }),
    );
    const warnings: string[] = [];

    try {
      expect(
        loadPublicConfig({ path, warn: (message) => warnings.push(message) }),
      ).toEqual({
        agents: {
          General: {},
          Explore: {},
          Review: { model: "p/review", thinking: "low" },
        },
      });
      expect(warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
