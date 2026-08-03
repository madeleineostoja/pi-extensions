import { describe, expect, it } from "vitest";
import { parseSandboxSettingChange, sandboxSettingItems } from "./settings.js";

describe("Sandbox settings adapter", () => {
  it("converts only bounded boolean and choice settings", () => {
    const settings = [
      { kind: "boolean", id: "mode", label: "Sandbox", value: true },
      {
        kind: "choice",
        id: "profile",
        label: "Profile",
        value: "strict",
        choices: ["strict", "relaxed"],
      },
    ] as const;

    expect(sandboxSettingItems(settings)).toEqual([
      {
        id: "mode",
        label: "Sandbox",
        description: undefined,
        currentValue: "on",
        values: ["on", "off"],
      },
      {
        id: "profile",
        label: "Profile",
        description: undefined,
        currentValue: "strict",
        values: ["strict", "relaxed"],
      },
    ]);
    expect(parseSandboxSettingChange(settings, "mode", "off")).toEqual({
      id: "mode",
      value: false,
    });
  });

  it("rejects duplicate IDs, invalid choices, and terminal control text", () => {
    expect(() =>
      sandboxSettingItems([
        { kind: "boolean", id: "mode", label: "Sandbox", value: true },
        { kind: "boolean", id: "mode", label: "Again", value: false },
      ]),
    ).toThrow("unique");
    expect(() =>
      sandboxSettingItems([
        {
          kind: "choice",
          id: "mode",
          label: "Sandbox",
          value: "on",
          choices: ["on", "on"],
        },
      ]),
    ).toThrow("choices");
    expect(() =>
      sandboxSettingItems([
        { kind: "boolean", id: "mode", label: "Sandbox\n", value: true },
      ]),
    ).toThrow("label");
    expect(() =>
      parseSandboxSettingChange(
        [{ kind: "boolean", id: "mode", label: "Sandbox", value: true }],
        "mode",
        "maybe",
      ),
    ).toThrow("boolean");
  });
});
