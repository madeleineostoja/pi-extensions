import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readConfig,
  writeConfig,
  resolveConfiguredModel,
  CONFIG_RELATIVE_PATH,
} from "./config.js";

describe("readConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-auto-name-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty object when config file is missing", () => {
    expect(readConfig(tmpDir)).toEqual({});
  });

  it("ignores unknown fields", () => {
    const configPath = join(tmpDir, CONFIG_RELATIVE_PATH);
    mkdirSync(join(tmpDir, "extensions", "pi-auto-name"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ model: "x/y", extra: 123 }),
      "utf-8",
    );
    expect(readConfig(tmpDir)).toEqual({ model: "x/y" });
  });

  it("returns empty object for malformed json", () => {
    const configPath = join(tmpDir, CONFIG_RELATIVE_PATH);
    mkdirSync(join(tmpDir, "extensions", "pi-auto-name"), { recursive: true });
    writeFileSync(configPath, "not json", "utf-8");
    expect(readConfig(tmpDir)).toEqual({});
  });

  it("returns empty object for non-object json", () => {
    writeConfig(tmpDir, { model: "x/y" });
    const configPath = join(tmpDir, CONFIG_RELATIVE_PATH);
    writeFileSync(configPath, "123", "utf-8");
    expect(readConfig(tmpDir)).toEqual({});
  });
});

describe("resolveConfiguredModel", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-auto-name-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no model is configured", () => {
    expect(resolveConfiguredModel(tmpDir)).toBeNull();
  });

  it("returns config model when configured", () => {
    writeConfig(tmpDir, { model: "openai/gpt-4.1-nano" });
    expect(resolveConfiguredModel(tmpDir)).toBe("openai/gpt-4.1-nano");
  });
});
