import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { validatePolicy, PolicyValidationError } from "../schema.js";
import { createPolicyManager, type NotifyTarget } from "../load.js";

describe("validatePolicy", () => {
  it("accepts an empty object (all defaults apply)", () => {
    const result = validatePolicy({});
    expect(result).toEqual({});
  });

  it("accepts a valid partial policy", () => {
    const result = validatePolicy({ network: { mode: "always" } });
    expect(result).toEqual({ network: { mode: "always" } });
  });

  it("accepts a full valid policy", () => {
    const result = validatePolicy({
      enabled: true,
      fs: {
        allowRead: ["/tmp"],
        allowWrite: ["/tmp"],
        denyPatterns: ["**/.env"],
      },
      network: {
        mode: "off",
        allow: ["example.com"],
      },
      audit: {
        log: false,
        logFile: "/var/log/audit.jsonl",
      },
    });
    expect(result.enabled).toBe(true);
    expect(result.network?.mode).toBe("off");
    expect(result.fs?.denyPatterns).toEqual(["**/.env"]);
    expect(result.audit?.log).toBe(false);
  });

  it("accepts all three network.mode values", () => {
    for (const mode of ["non-interactive-only", "always", "off"] as const) {
      const result = validatePolicy({ network: { mode } });
      expect(result.network?.mode).toBe(mode);
    }
  });

  it("rejects non-object input", () => {
    expect(() => validatePolicy("string")).toThrow(PolicyValidationError);
    expect(() => validatePolicy(42)).toThrow(PolicyValidationError);
    expect(() => validatePolicy(null)).toThrow(PolicyValidationError);
    expect(() => validatePolicy([])).toThrow(PolicyValidationError);
  });

  it("rejects unknown top-level fields", () => {
    expect(() => validatePolicy({ unknownField: true })).toThrow(
      PolicyValidationError,
    );
    expect(() => validatePolicy({ unknownField: true })).toThrow(
      /Unknown field/,
    );
  });

  it("rejects unknown fs fields", () => {
    expect(() =>
      validatePolicy({ fs: { allowRead: [], extra: true } }),
    ).toThrow(PolicyValidationError);
  });

  it("rejects unknown network fields", () => {
    expect(() =>
      validatePolicy({ network: { mode: "always", badField: true } }),
    ).toThrow(PolicyValidationError);
  });

  it("rejects unknown audit fields", () => {
    expect(() => validatePolicy({ audit: { log: true, extra: "x" } })).toThrow(
      PolicyValidationError,
    );
  });

  it("rejects wrong type for enabled", () => {
    expect(() => validatePolicy({ enabled: "yes" })).toThrow(
      PolicyValidationError,
    );
    expect(() => validatePolicy({ enabled: 1 })).toThrow(PolicyValidationError);
  });

  it("rejects wrong type for network.mode", () => {
    expect(() => validatePolicy({ network: { mode: "invalid-mode" } })).toThrow(
      PolicyValidationError,
    );
  });

  it("rejects non-array fs.allowRead", () => {
    expect(() => validatePolicy({ fs: { allowRead: "string" } })).toThrow(
      PolicyValidationError,
    );
  });

  it("rejects non-string entries in string arrays", () => {
    expect(() => validatePolicy({ fs: { allowRead: ["/good", 42] } })).toThrow(
      PolicyValidationError,
    );
  });

  it("rejects wrong type for audit.log", () => {
    expect(() => validatePolicy({ audit: { log: "true" } })).toThrow(
      PolicyValidationError,
    );
  });

  it("rejects wrong type for audit.logFile", () => {
    expect(() => validatePolicy({ audit: { logFile: 99 } })).toThrow(
      PolicyValidationError,
    );
  });

  it("rejects non-object fs", () => {
    expect(() => validatePolicy({ fs: "bad" })).toThrow(PolicyValidationError);
  });

  it("rejects non-object network", () => {
    expect(() => validatePolicy({ network: [1, 2] })).toThrow(
      PolicyValidationError,
    );
  });

  it("rejects non-object audit", () => {
    expect(() => validatePolicy({ audit: null })).toThrow(
      PolicyValidationError,
    );
  });

  it("accepts valid hostname entries in network.allow", () => {
    const result = validatePolicy({
      network: {
        allow: [
          "example.com",
          "api.example.com",
          "*.example.com",
          "*.github.com",
          "github.com",
        ],
      },
    });
    expect(result.network?.allow).toHaveLength(5);
  });

  it("rejects representative invalid network.allow hosts", () => {
    expect(() =>
      validatePolicy({ network: { allow: ["192.168.1.0/24"] } }),
    ).toThrow(PolicyValidationError);
    expect(() => validatePolicy({ network: { allow: ["host/path"] } })).toThrow(
      PolicyValidationError,
    );
  });
});

describe("loadPolicy — darwin unanchored denyPattern warning", () => {
  let tmpCwd: string;
  let tmpHome: string;
  let mockUi: { notify: ReturnType<typeof vi.fn<NotifyTarget["notify"]>> };

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-schema-test-"));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-schema-home-"));
    mockUi = { notify: vi.fn<NotifyTarget["notify"]>() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeJson(filePath: string, data: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  it("darwin + unanchored pattern → ui.notify warning fires once per unanchored pattern", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(
      tmpHome,
      ".pi",
      "agent",
      "extensions",
      "pi-sandbox",
      "config.json",
    );
    writeJson(globalPath, {
      fs: { denyPatterns: ["**/.env", "**/.secret"] },
    });

    loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi, platform: "darwin" });

    const warnCalls = (
      mockUi.notify as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([msg, level]) =>
        level === "warning" && (msg as string).includes("no literal prefix"),
    );
    expect(warnCalls).toHaveLength(2);
    expect(warnCalls[0][0]).toContain("**/.env");
    expect(warnCalls[1][0]).toContain("**/.secret");
  });

  it("linux + unanchored pattern → no darwin-specific warning", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(
      tmpHome,
      ".pi",
      "agent",
      "extensions",
      "pi-sandbox",
      "config.json",
    );
    writeJson(globalPath, {
      fs: { denyPatterns: ["**/.env"] },
    });

    loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi, platform: "linux" });

    const warnCalls = (
      mockUi.notify as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([msg, level]) =>
        level === "warning" && (msg as string).includes("no literal prefix"),
    );
    expect(warnCalls).toHaveLength(0);
  });

  it("darwin + anchored pattern → no warning", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(
      tmpHome,
      ".pi",
      "agent",
      "extensions",
      "pi-sandbox",
      "config.json",
    );
    writeJson(globalPath, {
      fs: { denyPatterns: ["<cwd>/**/.env", "~/.ssh/**"] },
    });

    loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi, platform: "darwin" });

    const warnCalls = (
      mockUi.notify as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([msg, level]) =>
        level === "warning" && (msg as string).includes("no literal prefix"),
    );
    expect(warnCalls).toHaveLength(0);
  });

  it("darwin + unanchored pattern warning message is actionable", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(
      tmpHome,
      ".pi",
      "agent",
      "extensions",
      "pi-sandbox",
      "config.json",
    );
    writeJson(globalPath, {
      fs: { denyPatterns: ["**/.env"] },
    });

    loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi, platform: "darwin" });

    const warnCalls = (
      mockUi.notify as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([msg, level]) =>
        level === "warning" && (msg as string).includes("no literal prefix"),
    );
    expect(warnCalls).toHaveLength(1);
    const msg = warnCalls[0][0] as string;
    expect(msg).toContain("**/.env");
    expect(msg).toContain("in-process gate");
    expect(msg).toContain("Anchor it");
  });
});
