import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createPolicyManager,
  expandPaths,
  expandPathsInPolicy,
  type NotifyTarget,
} from "../load.js";
import { DEFAULT_POLICY, type Policy } from "../defaults.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-sandbox-test-"));
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function writeRaw(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

describe("expandPaths", () => {
  it("expands <cwd> to the provided cwd", () => {
    expect(expandPaths("<cwd>", "/project")).toBe("/project");
    expect(expandPaths("<cwd>/src", "/project")).toBe("/project/src");
  });

  it("expands ~ to the home directory", () => {
    expect(expandPaths("~/.cache", "/project", "/home/user")).toBe(
      "/home/user/.cache",
    );
    expect(expandPaths("~", "/project", "/home/user")).toBe("/home/user");
  });

  it("expands environment variables", () => {
    process.env.PI_TEST_VAR = "/some/path";
    expect(expandPaths("$PI_TEST_VAR/sub", "/project")).toBe("/some/path/sub");
    delete process.env.PI_TEST_VAR;
  });

  it("leaves an unset env var unexpanded", () => {
    delete process.env.DOES_NOT_EXIST;
    expect(expandPaths("$DOES_NOT_EXIST/sub", "/project")).toBe(
      "$DOES_NOT_EXIST/sub",
    );
  });

  it("leaves regular paths unchanged", () => {
    expect(expandPaths("/usr/local", "/project")).toBe("/usr/local");
  });

  it("replaces <cwd> at the start of the string", () => {
    expect(expandPaths("<cwd>/src", "/wd")).toBe("/wd/src");
  });

  it("replaces <cwd> in the middle of the string", () => {
    expect(expandPaths("prefix/<cwd>/x", "/wd")).toBe("prefix//wd/x");
  });

  it("replaces <cwd> at the end of the string", () => {
    expect(expandPaths("root/<cwd>", "/wd")).toBe("root//wd");
  });

  it("replaces multiple <cwd> occurrences globally", () => {
    expect(expandPaths("<cwd>/a/<cwd>/b", "/wd")).toBe("/wd/a//wd/b");
  });
});

describe("expandPathsInPolicy", () => {
  const BASE_POLICY: Policy = {
    ...DEFAULT_POLICY,
    fs: {
      ...DEFAULT_POLICY.fs,
      allowRead: ["<cwd>"],
      allowWrite: ["<cwd>"],
      denyPatterns: ["~/.secret", "<cwd>/.env", "$PI_DENY_TEST/blocked"],
    },
    audit: {
      ...DEFAULT_POLICY.audit,
      logFile: "~/.pi/agent/logs/sandbox-audit.jsonl",
    },
  };

  it("expands <cwd> in denyPatterns", () => {
    const result = expandPathsInPolicy(BASE_POLICY, "/wd", "/home/user");
    expect(result.fs.denyPatterns).toContain("/wd/.env");
  });

  it("expands ~ in denyPatterns", () => {
    const result = expandPathsInPolicy(BASE_POLICY, "/wd", "/home/user");
    expect(result.fs.denyPatterns).toContain("/home/user/.secret");
  });

  it("expands $VAR in denyPatterns", () => {
    process.env.PI_DENY_TEST = "/denied";
    const result = expandPathsInPolicy(BASE_POLICY, "/wd", "/home/user");
    expect(result.fs.denyPatterns).toContain("/denied/blocked");
    delete process.env.PI_DENY_TEST;
  });

  it("regression: expands allowRead and allowWrite as before", () => {
    const result = expandPathsInPolicy(BASE_POLICY, "/wd", "/home/user");
    expect(result.fs.allowRead).toContain("/wd");
    expect(result.fs.allowWrite).toContain("/wd");
  });

  it("regression: expands audit.logFile as before", () => {
    const result = expandPathsInPolicy(BASE_POLICY, "/wd", "/home/user");
    expect(result.audit.logFile).toBe(
      "/home/user/.pi/agent/logs/sandbox-audit.jsonl",
    );
  });
});

describe("loadPolicy", () => {
  let tmpCwd: string;
  let tmpHome: string;
  let mockUi: { notify: ReturnType<typeof vi.fn<NotifyTarget["notify"]>> };

  beforeEach(() => {
    tmpCwd = makeTmpDir();
    tmpHome = makeTmpDir();
    mockUi = { notify: vi.fn<NotifyTarget["notify"]>() };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns defaults when no config files exist", () => {
    const { loadPolicy } = createPolicyManager();
    const policy = loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    expect(policy.enabled).toBe(DEFAULT_POLICY.enabled);
    expect(policy.network.mode).toBe(DEFAULT_POLICY.network.mode);
    expect(policy.network.allow).toEqual(DEFAULT_POLICY.network.allow);
    expect(mockUi.notify).not.toHaveBeenCalled();
  });

  it("defaults match the spec's Default Policy block", () => {
    const { loadPolicy } = createPolicyManager();
    const policy = loadPolicy(tmpCwd, { home: tmpHome });

    expect(policy.network.mode).toBe("non-interactive-only");
    expect(policy.enabled).toBe(true);
    expect(policy.audit.log).toBe(true);
    expect(policy.fs.denyPatterns.some((p) => p.endsWith("/.env"))).toBe(true);
    expect(policy.fs.denyPatterns.some((p) => p.includes(".ssh"))).toBe(true);
    expect(policy.network.allow).toContain("github.com");
    expect(policy.network.allow).toContain("registry.npmjs.org");
  });

  it("merges global config over defaults", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeJson(globalPath, { network: { mode: "always" } });

    const policy = loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    expect(policy.network.mode).toBe("always");
    expect(policy.enabled).toBe(DEFAULT_POLICY.enabled);
    expect(policy.network.allow).toEqual(DEFAULT_POLICY.network.allow);
    expect(mockUi.notify).not.toHaveBeenCalled();
  });

  it("merges project config over global config", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeJson(globalPath, { network: { mode: "always" } });

    const projectPath = path.join(tmpCwd, ".pi", "sandbox.json");
    writeJson(projectPath, { network: { mode: "off" } });

    const policy = loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    expect(policy.network.mode).toBe("off");
    expect(mockUi.notify).not.toHaveBeenCalled();
  });

  it("array fields are replaced, not concatenated", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeJson(globalPath, { network: { allow: ["custom.example.com"] } });

    const policy = loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    expect(policy.network.allow).toEqual(["custom.example.com"]);
    expect(policy.network.allow).not.toContain("github.com");
  });

  it("project config array overrides global config array", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeJson(globalPath, { network: { allow: ["global.example.com"] } });

    const projectPath = path.join(tmpCwd, ".pi", "sandbox.json");
    writeJson(projectPath, { network: { allow: ["project.example.com"] } });

    const policy = loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    expect(policy.network.allow).toEqual(["project.example.com"]);
    expect(policy.network.allow).not.toContain("global.example.com");
  });

  it("expands ~ in paths at load time", () => {
    const { loadPolicy } = createPolicyManager();
    const policy = loadPolicy(tmpCwd, { home: tmpHome });

    for (const p of policy.fs.allowRead) {
      expect(p).not.toMatch(/^~/);
    }
    for (const p of policy.fs.allowWrite) {
      expect(p).not.toMatch(/^~/);
    }
    expect(policy.audit.logFile).not.toMatch(/^~/);
    expect(policy.audit.logFile).toContain(tmpHome);
  });

  it("expands <cwd> in paths at load time", () => {
    const { loadPolicy } = createPolicyManager();
    const policy = loadPolicy(tmpCwd, { home: tmpHome });

    expect(policy.fs.allowRead).toContain(tmpCwd);
    expect(policy.fs.allowWrite).toContain(tmpCwd);
  });

  it("falls back to defaults and emits error on invalid JSON", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeRaw(globalPath, "{ this is not json");

    const policy = loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    expect(policy.network.mode).toBe(DEFAULT_POLICY.network.mode);
    expect(mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("invalid JSON"),
      "error",
    );
  });

  it("falls back to defaults and emits error on schema violation", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeJson(globalPath, { unknownField: true });

    const policy = loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    expect(policy.network.mode).toBe(DEFAULT_POLICY.network.mode);
    expect(mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("config error"),
      "error",
    );
  });

  it("falls back to defaults and emits error on wrong type", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeJson(globalPath, { network: { mode: "bad-mode" } });

    const policy = loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    expect(policy.network.mode).toBe(DEFAULT_POLICY.network.mode);
    expect(mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("config error"),
      "error",
    );
  });

  it("parses JSONC (comments and trailing commas) without error", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeRaw(
      globalPath,
      `{
        // a comment
        "network": {
          "mode": "always", // trailing comma
        },
      }`,
    );

    const policy = loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    expect(policy.network.mode).toBe("always");
    expect(mockUi.notify).not.toHaveBeenCalled();
  });

  it("invalid file that is a non-object JSON is rejected gracefully", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeRaw(globalPath, '"just a string"');

    const policy = loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    expect(policy.network.mode).toBe(DEFAULT_POLICY.network.mode);
    expect(mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("config error"),
      "error",
    );
  });

  it("emits warn when network.mode is 'always' and allow is empty", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeJson(globalPath, { network: { mode: "always", allow: [] } });

    loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    expect(mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("network mode is 'always' with no allowed hosts"),
      "warning",
    );
  });

  it("fires the always+empty-allow warning once per load, not repeatedly", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeJson(globalPath, { network: { mode: "always", allow: [] } });

    loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });
    loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    const warnCalls = (
      mockUi.notify as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([, level]) => level === "warning");
    expect(warnCalls).toHaveLength(2);
  });

  it("does not warn when network.mode is 'always' and allow is non-empty", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeJson(globalPath, {
      network: { mode: "always", allow: ["example.com"] },
    });

    loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    const warnCalls = (
      mockUi.notify as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([, level]) => level === "warning");
    expect(warnCalls).toHaveLength(0);
  });

  it("does not warn when network.mode is 'off' and allow is empty", () => {
    const { loadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeJson(globalPath, { network: { mode: "off", allow: [] } });

    loadPolicy(tmpCwd, { home: tmpHome, ui: mockUi });

    const warnCalls = (
      mockUi.notify as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([, level]) => level === "warning");
    expect(warnCalls).toHaveLength(0);
  });
});

describe("reloadPolicy", () => {
  let tmpCwd: string;
  let tmpHome: string;

  beforeEach(() => {
    tmpCwd = makeTmpDir();
    tmpHome = makeTmpDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns updated policy after file changes on disk", () => {
    const { reloadPolicy } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");

    writeJson(globalPath, { network: { mode: "always" } });
    const first = reloadPolicy(tmpCwd, { home: tmpHome });
    expect(first.network.mode).toBe("always");

    writeJson(globalPath, { network: { mode: "off" } });
    const second = reloadPolicy(tmpCwd, { home: tmpHome });
    expect(second.network.mode).toBe("off");
  });

  it("notifies subscribers on reload", () => {
    const { reloadPolicy, subscribe } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeJson(globalPath, { network: { mode: "always" } });

    const received: string[] = [];
    const unsub = subscribe((policy) => {
      received.push(policy.network.mode);
    });

    reloadPolicy(tmpCwd, { home: tmpHome });
    reloadPolicy(tmpCwd, { home: tmpHome });

    expect(received).toHaveLength(2);
    unsub();

    reloadPolicy(tmpCwd, { home: tmpHome });
    expect(received).toHaveLength(2);
  });

  it("subscriber receives the new policy after disk change", () => {
    const { reloadPolicy, subscribe } = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeJson(globalPath, { network: { mode: "always" } });

    let lastMode = "";
    const unsub = subscribe((policy) => {
      lastMode = policy.network.mode;
    });

    reloadPolicy(tmpCwd, { home: tmpHome });
    expect(lastMode).toBe("always");

    writeJson(globalPath, { network: { mode: "off" } });
    reloadPolicy(tmpCwd, { home: tmpHome });
    expect(lastMode).toBe("off");

    unsub();
  });

  it("subscribers from separate manager instances do not cross-notify", () => {
    const managerA = createPolicyManager();
    const managerB = createPolicyManager();
    const globalPath = path.join(tmpHome, ".pi", "agent", "sandbox.json");
    writeJson(globalPath, { network: { mode: "always" } });

    const receivedA: string[] = [];
    const receivedB: string[] = [];
    managerA.subscribe((p) => receivedA.push(p.network.mode));
    managerB.subscribe((p) => receivedB.push(p.network.mode));

    managerA.reloadPolicy(tmpCwd, { home: tmpHome });

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);
  });
});
