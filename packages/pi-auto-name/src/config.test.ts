import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readConfig,
  writeConfig,
  resolveEffectiveModel,
  DEFAULT_MODEL,
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

  it("reads model override from config file", () => {
    writeConfig(tmpDir, { model: "openai/gpt-4.1-nano" });
    expect(readConfig(tmpDir)).toEqual({ model: "openai/gpt-4.1-nano" });
  });

  it("ignores unknown fields", () => {
    const configPath = join(
      tmpDir,
      "extensions",
      "pi-auto-name",
      "config.json",
    );
    mkdirSync(join(tmpDir, "extensions", "pi-auto-name"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ model: "x/y", extra: 123 }),
      "utf-8",
    );
    expect(readConfig(tmpDir)).toEqual({ model: "x/y" });
  });

  it("returns empty object for malformed json", () => {
    const configPath = join(
      tmpDir,
      "extensions",
      "pi-auto-name",
      "config.json",
    );
    mkdirSync(join(tmpDir, "extensions", "pi-auto-name"), { recursive: true });
    writeFileSync(configPath, "not json", "utf-8");
    expect(readConfig(tmpDir)).toEqual({});
  });

  it("returns empty object for non-object json", () => {
    writeConfig(tmpDir, { model: "x/y" });
    const configPath = join(
      tmpDir,
      "extensions",
      "pi-auto-name",
      "config.json",
    );
    writeFileSync(configPath, "123", "utf-8");
    expect(readConfig(tmpDir)).toEqual({});
  });
});

describe("writeConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-auto-name-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates nested directories and writes config", () => {
    writeConfig(tmpDir, { model: "openai/gpt-4.1-nano" });
    expect(readConfig(tmpDir)).toEqual({ model: "openai/gpt-4.1-nano" });
  });

  it("overwrites existing config", () => {
    writeConfig(tmpDir, { model: "a/b" });
    writeConfig(tmpDir, { model: "c/d" });
    expect(readConfig(tmpDir)).toEqual({ model: "c/d" });
  });
});

describe("resolveEffectiveModel", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-auto-name-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns default model when no config exists", () => {
    const result = resolveEffectiveModel(tmpDir);
    expect(result.model).toBe(DEFAULT_MODEL);
    expect(result.source).toBe("default");
  });

  it("returns config model when override exists", () => {
    writeConfig(tmpDir, { model: "openai/gpt-4.1-nano" });
    const result = resolveEffectiveModel(tmpDir);
    expect(result.model).toBe("openai/gpt-4.1-nano");
    expect(result.source).toBe("config");
  });
});
