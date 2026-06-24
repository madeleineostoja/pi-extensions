import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  parseArgs,
  getArgumentCompletions,
  isValidHost,
  writeHostsToPersisted,
  removeHostFromPersistedFile,
  createSlashCommands,
  type SubcommandContext,
} from "./commands.js";
import { createAuditPipeline } from "../audit/audit.js";
import type { Policy } from "../policy/defaults.js";
import type { PolicyManager } from "../policy/load.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    enabled: true,
    fs: {
      allowRead: ["/tmp"],
      allowWrite: ["/tmp"],
      denyPatterns: ["**/.env"],
    },
    network: {
      mode: "non-interactive-only",
      allow: ["github.com", "*.github.com"],
    },
    audit: { log: false, logFile: "/tmp/audit.jsonl" },
    enforcement: { requireKernelSandbox: false },
    ...overrides,
  };
}

function makePolicyManager(policy: Policy): PolicyManager {
  let current = policy;
  return {
    getPolicy: () => current,
    loadPolicy: (_cwd: string) => current,
    reloadPolicy: (_cwd: string) => {
      return current;
    },
    subscribe: () => () => {},
  };
}

function makeUI(dialog?: {
  selectReturns?: (string | undefined)[];
  inputReturns?: (string | undefined)[];
  confirmReturns?: boolean[];
}): {
  ui: SubcommandContext["ui"];
  messages: Array<{ text: string; level?: string }>;
  selectCalls: Array<{ title: string; options: string[] }>;
  inputCalls: Array<{ title: string; placeholder?: string }>;
  confirmCalls: Array<{ title: string; message: string }>;
} {
  const messages: Array<{ text: string; level?: string }> = [];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const inputCalls: Array<{ title: string; placeholder?: string }> = [];
  const confirmCalls: Array<{ title: string; message: string }> = [];

  let selectIdx = 0;
  let inputIdx = 0;
  let confirmIdx = 0;

  const ui: SubcommandContext["ui"] = {
    notify: (text, level) => messages.push({ text, level }),
    select: async (title, options) => {
      selectCalls.push({ title, options });
      const result = dialog?.selectReturns?.[selectIdx++];
      return result === undefined ? undefined : result;
    },
    input: async (title, placeholder) => {
      inputCalls.push({ title, placeholder });
      const result = dialog?.inputReturns?.[inputIdx++];
      return result === undefined ? undefined : result;
    },
    confirm: async (title, message) => {
      confirmCalls.push({ title, message });
      const result = dialog?.confirmReturns?.[confirmIdx++];
      return result === undefined ? false : result;
    },
  };
  return { ui, messages, selectCalls, inputCalls, confirmCalls };
}

function makeEvents() {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const events = {
    emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
  };
  return { events, emitted };
}

function makeCtx(
  overrides: Partial<SubcommandContext> = {},
): SubcommandContext {
  const policy = makePolicy();
  const policyManager = makePolicyManager(policy);
  const { ui } = makeUI();
  return {
    ui,
    policyManager,
    cwd: os.tmpdir(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs — subcommand parsing", () => {
  it("parses empty input and simple subcommands", () => {
    expect(parseArgs("").subcommand).toBe("");
    expect(parseArgs("   ").subcommand).toBe("");
    expect(parseArgs("status").subcommand).toBe("status");
    expect(parseArgs("reload").subcommand).toBe("reload");
    expect(parseArgs("on").subcommand).toBe("on");
    expect(parseArgs("off").subcommand).toBe("off");
  });

  it("parses why targets", () => {
    expect(parseArgs("why /some/path")).toMatchObject({
      subcommand: "why",
      target: "/some/path",
    });
    expect(parseArgs("why evil.com")).toMatchObject({
      subcommand: "why",
      target: "evil.com",
    });
  });

  it("parses allow resources and persistence flags", () => {
    expect(parseArgs("allow host github.com")).toMatchObject({
      subcommand: "allow",
      resource: "host",
      hosts: ["github.com"],
      persist: false,
    });
    expect(parseArgs("allow host a.com b.com c.com").hosts).toEqual([
      "a.com",
      "b.com",
      "c.com",
    ]);
    expect(parseArgs("allow host --persist github.com").persist).toBe(
      "project",
    );
    expect(parseArgs("allow host --persist=user github.com").persist).toBe(
      "user",
    );
    expect(parseArgs("allow read /tmp/file")).toMatchObject({
      subcommand: "allow",
      resource: "read",
      target: "/tmp/file",
    });
  });

  it("parses revoke and network subcommands", () => {
    expect(parseArgs("revoke host github.com")).toMatchObject({
      subcommand: "revoke",
      resource: "host",
      target: "github.com",
    });
    expect(parseArgs("revoke host --persist github.com").persist).toBe(
      "project",
    );
    expect(parseArgs("network off")).toMatchObject({
      subcommand: "network",
      target: "off",
    });
    expect(parseArgs("network on")).toMatchObject({
      subcommand: "network",
      target: "on",
    });
  });
});

// ---------------------------------------------------------------------------
// isValidHost
// ---------------------------------------------------------------------------

describe("isValidHost", () => {
  it("accepts a plain hostname", () => {
    expect(isValidHost("github.com")).toBe(true);
  });

  it("accepts a wildcard prefix", () => {
    expect(isValidHost("*.github.com")).toBe(true);
  });

  it("rejects a CIDR range (slash present)", () => {
    expect(isValidHost("192.168.0.0/24")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session state mutations
// ---------------------------------------------------------------------------

describe("session state — allow", () => {
  let cmds: ReturnType<typeof createSlashCommands>;
  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  it("adds a host to session grants", () => {
    const { ui } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleAllow(ctx, ["example.com"], false);
    expect(cmds.getSessionState().sessionAllowedHosts.has("example.com")).toBe(
      true,
    );
  });

  it("rejects invalid host with no partial grant", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleAllow(ctx, ["192.168.0.0/24"], false);
    expect(cmds.getSessionState().sessionAllowedHosts.size).toBe(0);
    expect(messages[0].level).toBe("error");
  });

  it("rejects all hosts when one is invalid (no partial grant)", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleAllow(ctx, ["good.com", "192.168.0.0/24"], false);
    expect(cmds.getSessionState().sessionAllowedHosts.size).toBe(0);
    expect(messages[0].level).toBe("error");
  });

  it("errors when no hosts provided", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleAllow(ctx, [], false);
    expect(messages[0].level).toBe("error");
  });
});

describe("session state — revoke", () => {
  let cmds: ReturnType<typeof createSlashCommands>;
  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  it("removes a host from session grants", () => {
    const { ui } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleAllow(ctx, ["example.com"], false);
    cmds.handleRevoke(ctx, "example.com", false);
    expect(cmds.getSessionState().sessionAllowedHosts.has("example.com")).toBe(
      false,
    );
  });

  it("errors when no host provided", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleRevoke(ctx, "", false);
    expect(messages[0].level).toBe("error");
  });
});

describe("session state — network toggle", () => {
  let cmds: ReturnType<typeof createSlashCommands>;
  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  it("network off sets networkOff=true", () => {
    const ctx = makeCtx();
    cmds.handleNetworkOff(ctx);
    expect(cmds.getSessionState().networkOff).toBe(true);
  });

  it("network on resets networkOff=false", () => {
    const ctx = makeCtx();
    cmds.handleNetworkOff(ctx);
    cmds.handleNetworkOn(ctx);
    expect(cmds.getSessionState().networkOff).toBe(false);
  });
});

describe("session state — sandbox on/off", () => {
  let cmds: ReturnType<typeof createSlashCommands>;
  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  it("off sets sandboxOff=true", () => {
    const ctx = makeCtx();
    cmds.handleOff(ctx);
    expect(cmds.getSessionState().sandboxOff).toBe(true);
  });

  it("on resets sandboxOff=false", () => {
    const ctx = makeCtx();
    cmds.handleOff(ctx);
    cmds.handleOn(ctx);
    expect(cmds.getSessionState().sandboxOff).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleStatus
// ---------------------------------------------------------------------------

describe("handleStatus", () => {
  let cmds: ReturnType<typeof createSlashCommands>;
  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  it("reports ON when active", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleStatus(ctx);
    expect(messages[0].text).toMatch(/sandbox: ON/i);
  });

  it("reports OFF when sandboxOff=true", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleOff(ctx);
    messages.length = 0;
    cmds.handleStatus(ctx);
    expect(messages[0].text).toMatch(/OFF/i);
  });
});

// ---------------------------------------------------------------------------
// handleSummary
// ---------------------------------------------------------------------------

describe("handleSummary", () => {
  let cmds: ReturnType<typeof createSlashCommands>;
  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  it("includes all policy fields", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleSummary(ctx);
    const text = messages[0].text;
    expect(text).toMatch(/Sandbox Policy Summary/);
    expect(text).toMatch(/Network mode/);
    expect(text).toMatch(/Allowed hosts/);
    expect(text).toMatch(/Session hosts/);
    expect(text).toMatch(/Session reads/);
    expect(text).toMatch(/Session writes/);
    expect(text).toMatch(/FS allow read/);
    expect(text).toMatch(/Deny patterns/);
    expect(text).toMatch(/Audit log/);
  });
});

// ---------------------------------------------------------------------------
// handleReload
// ---------------------------------------------------------------------------

describe("handleReload", () => {
  let cmds: ReturnType<typeof createSlashCommands>;
  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  it("surfaces error with file path and reason when reloadPolicy throws", () => {
    const { ui, messages } = makeUI();
    const policy = makePolicy();
    const configPath = "/home/user/.pi/agent/extensions/pi-sandbox/config.json";
    const policyManager: PolicyManager = {
      getPolicy: () => policy,
      loadPolicy: (_cwd) => policy,
      reloadPolicy: (_cwd) => {
        throw new Error(`invalid JSON in ${configPath}: Unexpected token`);
      },
      subscribe: () => () => {},
    };
    const ctx: SubcommandContext = { ui, policyManager, cwd: os.tmpdir() };
    cmds.handleReload(ctx);
    expect(messages[0].level).toBe("error");
    expect(messages[0].text).toContain(configPath);
    expect(messages[0].text).toContain("Unexpected token");
  });
});

// ---------------------------------------------------------------------------
// Audit event emission on mutations
// ---------------------------------------------------------------------------

describe("audit event emission", () => {
  let cmds: ReturnType<typeof createSlashCommands>;
  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  it("allow emits sandbox:audit with kind=policy-change decision=granted scope=session", () => {
    const { events, emitted } = makeEvents();
    const { ui } = makeUI();
    const ctx = makeCtx({ ui, events });
    cmds.handleAllow(ctx, ["example.com"], false);
    const auditEvents = emitted.filter((e) => e.event === "sandbox:audit");
    expect(auditEvents.length).toBeGreaterThan(0);
    const payload = auditEvents[0].payload as Record<string, unknown>;
    expect(payload.kind).toBe("policy-change");
    expect(payload.decision).toBe("granted");
    expect(payload.source).toBe("command");
    expect(payload.scope).toBe("session");
  });

  it("revoke emits sandbox:audit with kind=policy-change decision=revoked", () => {
    const { events, emitted } = makeEvents();
    const { ui } = makeUI();
    const ctx = makeCtx({ ui, events });
    cmds.handleAllow(ctx, ["example.com"], false);
    emitted.length = 0;
    cmds.handleRevoke(ctx, "example.com", false);
    const auditEvents = emitted.filter((e) => e.event === "sandbox:audit");
    expect(auditEvents.length).toBeGreaterThan(0);
    const payload = auditEvents[0].payload as Record<string, unknown>;
    expect(payload.kind).toBe("policy-change");
    expect(payload.decision).toBe("revoked");
    expect(payload.source).toBe("command");
  });

  it("network off emits sandbox:audit", () => {
    const { events, emitted } = makeEvents();
    const ctx = makeCtx({ events });
    cmds.handleNetworkOff(ctx);
    expect(
      emitted.filter((e) => e.event === "sandbox:audit").length,
    ).toBeGreaterThan(0);
  });

  it("sandbox off emits sandbox:audit", () => {
    const { events, emitted } = makeEvents();
    const ctx = makeCtx({ events });
    cmds.handleOff(ctx);
    expect(
      emitted.filter((e) => e.event === "sandbox:audit").length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tab completion
// ---------------------------------------------------------------------------

function completionValues(
  items: ReturnType<typeof getArgumentCompletions>,
): string[] {
  if (!items) {
    return [];
  }
  return items.map((i) => i.value);
}

describe("getArgumentCompletions — tab completion", () => {
  beforeEach(() => {
    createSlashCommands(createAuditPipeline());
  });

  it("suggests retained top-level commands and filters by prefix", () => {
    const pm = makePolicyManager(makePolicy());
    expect(completionValues(getArgumentCompletions("", pm))).toEqual([
      "why",
      "allow",
      "revoke",
    ]);
    const filtered = completionValues(getArgumentCompletions("al", pm));
    expect(filtered).toEqual(["allow"]);
    expect(filtered).not.toContain("status");
  });

  it("suggests recently-blocked hosts for allow", () => {
    const { events } = makeEvents();
    const pipeline = createAuditPipeline();
    pipeline.recordAudit(
      { kind: "network", decision: "blocked", host: "blocked.example.com" },
      { events },
    );
    const pm = makePolicyManager(makePolicy());
    const values = completionValues(
      getArgumentCompletions(
        "allow host ",
        pm,
        undefined,
        pipeline.getRecentBlockedHosts,
      ),
    );
    expect(values).toContain("blocked.example.com");
  });

  it("suggests revocable hosts and filesystem grant resources", () => {
    const pm = makePolicyManager(makePolicy());
    expect(
      completionValues(getArgumentCompletions("revoke host ", pm)),
    ).toContain("github.com");
    expect(completionValues(getArgumentCompletions("allow ", pm))).toEqual([
      "host",
      "read",
      "write",
    ]);
    expect(completionValues(getArgumentCompletions("revoke ", pm))).toEqual([
      "host",
      "read",
      "write",
    ]);
    expect(completionValues(getArgumentCompletions("network ", pm))).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// dispatch integration
// ---------------------------------------------------------------------------

describe("dispatch — subcommand routing", () => {
  let cmds: ReturnType<typeof createSlashCommands>;
  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  it("empty args → opens sectioned menu", async () => {
    const { ui, messages, selectCalls } = makeUI({
      selectReturns: ["Inspect…", "Policy summary", undefined],
    });
    const ctx = makeCtx({ ui });
    await cmds.dispatch("", ctx);
    expect(selectCalls[0].title).toBe("Sandbox");
    expect(selectCalls[0].options).toEqual([
      "Inspect…",
      "Filesystem…",
      "Network…",
      "Session…",
      "Reload",
    ]);
    expect(messages[0].text).toMatch(/Sandbox Policy Summary/);
  });

  it("'summary' → prints summary", async () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    await cmds.dispatch("summary", ctx);
    expect(messages[0].text).toMatch(/Sandbox Policy Summary/);
  });

  it("'status' → one-liner", async () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    await cmds.dispatch("status", ctx);
    expect(messages[0].text).toMatch(/sandbox:/i);
    expect(messages[0].text).not.toMatch(/\n/);
  });

  it("'off' → disables sandbox", async () => {
    const ctx = makeCtx();
    await cmds.dispatch("off", ctx);
    expect(cmds.getSessionState().sandboxOff).toBe(true);
  });

  it("'network off' → disables network", async () => {
    const ctx = makeCtx();
    await cmds.dispatch("network off", ctx);
    expect(cmds.getSessionState().networkOff).toBe(true);
  });

  it("'allow host github.com' → session grant", async () => {
    const ctx = makeCtx();
    await cmds.dispatch("allow host github.com", ctx);
    expect(cmds.getSessionState().sessionAllowedHosts.has("github.com")).toBe(
      true,
    );
  });

  it("'allow host 192.168.0.0/24' → error, no state change", async () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    await cmds.dispatch("allow host 192.168.0.0/24", ctx);
    expect(messages[0].level).toBe("error");
    expect(cmds.getSessionState().sessionAllowedHosts.size).toBe(0);
  });

  it("unknown subcommand → error message", async () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    await cmds.dispatch("notacommand", ctx);
    expect(messages[0].level).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// --persist: write to temp file, verify comments preserved
// ---------------------------------------------------------------------------

describe("--persist write preserves comments", () => {
  let tmpDir: string;
  let cmds: ReturnType<typeof createSlashCommands>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slash-test-"));
    cmds = createSlashCommands(createAuditPipeline());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes to project config and merges with existing content", () => {
    const configDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "sandbox.json");

    fs.writeFileSync(
      configPath,
      '{ "network": { "allow": ["existing.com"] } }\n',
    );

    const { ui } = makeUI();
    const policy = makePolicy();
    let reloadCalled = false;
    const policyManager: PolicyManager = {
      getPolicy: () => policy,
      loadPolicy: (_cwd) => policy,
      reloadPolicy: (_cwd) => {
        reloadCalled = true;
        return policy;
      },
      subscribe: () => () => {},
    };
    const ctx: SubcommandContext = { ui, policyManager, cwd: tmpDir };

    cmds.handleAllow(ctx, ["newhost.com"], "project");

    expect(reloadCalled).toBe(true);
    const written = fs.readFileSync(configPath, "utf8");

    expect(written).toContain("existing.com");
    expect(written).toContain("newhost.com");
  });

  it("creates the config file if it does not exist", () => {
    const { ui } = makeUI();
    const policy = makePolicy();
    const policyManager = makePolicyManager(policy);
    const ctx: SubcommandContext = { ui, policyManager, cwd: tmpDir };

    cmds.handleAllow(ctx, ["created.com"], "project");

    const configPath = path.join(tmpDir, ".pi", "sandbox.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const written = fs.readFileSync(configPath, "utf8");
    expect(written).toContain("created.com");
  });

  it("removes a host from persisted config (removeHostFromPersistedFile)", () => {
    const configPath = path.join(tmpDir, "sandbox.json");
    fs.writeFileSync(
      configPath,
      '{ "network": { "allow": ["keep.com", "remove.com"] } }\n',
    );

    const removed = removeHostFromPersistedFile(configPath, "remove.com");
    expect(removed).toBe(true);

    const written = fs.readFileSync(configPath, "utf8");
    expect(written).toContain("keep.com");
    expect(written).not.toContain("remove.com");
  });
});

// ---------------------------------------------------------------------------
// writeHostsToPersisted — direct unit test
// ---------------------------------------------------------------------------

describe("writeHostsToPersisted", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-persist-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds hosts to network.allow array preserving existing content", () => {
    const filePath = path.join(tmpDir, "sandbox.json");
    fs.writeFileSync(filePath, '{ "network": { "allow": ["a.com"] } }');

    writeHostsToPersisted(filePath, ["b.com", "c.com"]);

    const src = fs.readFileSync(filePath, "utf8");
    expect(src).toContain("a.com");
    expect(src).toContain("b.com");
    expect(src).toContain("c.com");
  });

  it("creates intermediate directories", () => {
    const filePath = path.join(tmpDir, "deep", "nested", "sandbox.json");
    writeHostsToPersisted(filePath, ["new.com"]);
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleWhy
// ---------------------------------------------------------------------------

describe("handleWhy", () => {
  let cmds: ReturnType<typeof createSlashCommands>;
  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  it("errors with no target", async () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    await cmds.handleWhy(ctx, "");
    expect(messages[0].level).toBe("error");
  });

  it("handleWhy and decideFsAccess agree on allowed path", async () => {
    const { decideFsAccess } = await import("../enforcement/decide.js");
    const { ui, messages } = makeUI();
    const policy = makePolicy({
      fs: { allowRead: ["/tmp"], allowWrite: [], denyPatterns: [] },
    });
    const ctx = makeCtx({ ui, policyManager: makePolicyManager(policy) });
    const target = "/tmp/file.txt";
    await cmds.handleWhy(ctx, target);
    const decision = await decideFsAccess(target, "read", policy, {
      cwd: os.tmpdir(),
    });
    expect(decision.allow).toBe(true);
    expect(messages[0].text).toMatch(/would be allowed/);
  });

  it("handleWhy and decideFsAccess agree on denyPattern block", async () => {
    const { decideFsAccess } = await import("../enforcement/decide.js");
    const { ui, messages } = makeUI();
    const policy = makePolicy({
      fs: { allowRead: ["/tmp"], allowWrite: [], denyPatterns: ["**/.env"] },
    });
    const ctx = makeCtx({
      ui,
      policyManager: makePolicyManager(policy),
      cwd: "/tmp",
    });
    const target = "/tmp/.env";
    await cmds.handleWhy(ctx, target);
    const decision = await decideFsAccess(target, "read", policy, {
      cwd: "/tmp",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.rule).toBe("denyPattern");
    }
    expect(messages[0].text).toMatch(/blocked by denyPattern/);
  });

  it("handleWhy and decideFsAccess agree on allowList block", async () => {
    const { decideFsAccess } = await import("../enforcement/decide.js");
    const { ui, messages } = makeUI();
    const policy = makePolicy({
      fs: { allowRead: ["/allowed"], allowWrite: [], denyPatterns: [] },
    });
    const ctx = makeCtx({ ui, policyManager: makePolicyManager(policy) });
    const target = "/not-allowed/file.txt";
    await cmds.handleWhy(ctx, target);
    const decision = await decideFsAccess(target, "read", policy, {
      cwd: os.tmpdir(),
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.rule).toBe("allowList:read");
    }
    expect(messages[0].text).toMatch(/blocked/);
  });
});

// ---------------------------------------------------------------------------
// persist="user" path with injected home directory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-host audit emission
// ---------------------------------------------------------------------------

describe("per-host audit emission", () => {
  let cmds: ReturnType<typeof createSlashCommands>;
  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  it("allow with multiple hosts emits one audit event per host", () => {
    const { events, emitted } = makeEvents();
    const { ui } = makeUI();
    const ctx = makeCtx({ ui, events });

    cmds.handleAllow(ctx, ["a.com", "b.com", "c.com"], false);

    const auditEvents = emitted.filter((e) => e.event === "sandbox:audit");
    expect(auditEvents).toHaveLength(3);
    const hosts = auditEvents.map(
      (e) => (e.payload as Record<string, unknown>).host,
    );
    expect(hosts).toContain("a.com");
    expect(hosts).toContain("b.com");
    expect(hosts).toContain("c.com");
  });
});

describe("registerSandboxCommand", () => {
  it("uses command context UI instead of stdout/stderr", async () => {
    const cmds = createSlashCommands(createAuditPipeline());
    const policyManager = makePolicyManager(makePolicy());

    let capturedHandler:
      | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
      | undefined;

    const mockPi = {
      registerCommand: (
        _name: string,
        options: {
          handler: (
            args: string,
            ctx: ExtensionCommandContext,
          ) => Promise<void>;
        },
      ) => {
        capturedHandler = options.handler;
      },
    } as unknown as ExtensionAPI;

    cmds.registerSandboxCommand(mockPi, policyManager, os.tmpdir());

    const notifyMock = vi.fn();
    const mockCtx = {
      ui: { notify: notifyMock },
    } as unknown as ExtensionCommandContext;

    await capturedHandler!("status", mockCtx);

    expect(notifyMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Menu handler
// ---------------------------------------------------------------------------

describe("handleMenu", () => {
  let cmds: ReturnType<typeof createSlashCommands>;

  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cancelling the top-level select exits with no state changes", async () => {
    const { ui, messages, selectCalls } = makeUI({
      selectReturns: [undefined],
    });
    const ctx = makeCtx({ ui });
    await cmds.handleMenu(ctx);
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0].title).toBe("Sandbox");
    expect(selectCalls[0].options).toEqual([
      "Inspect…",
      "Filesystem…",
      "Network…",
      "Session…",
      "Reload",
    ]);
    expect(messages).toHaveLength(0);
  });

  it("submenu escape returns to the parent menu before top-level escape exits", async () => {
    const { ui, messages, selectCalls } = makeUI({
      selectReturns: ["Inspect…", undefined, undefined],
    });
    const ctx = makeCtx({ ui });
    await cmds.handleMenu(ctx);
    expect(selectCalls.map((call) => call.title)).toEqual([
      "Sandbox",
      "Sandbox › Inspect",
      "Sandbox",
    ]);
    expect(messages).toHaveLength(0);
  });

  it("explicit Back returns from a submenu to the parent menu", async () => {
    const { ui, selectCalls } = makeUI({
      selectReturns: ["Network…", "Back", undefined],
    });
    const ctx = makeCtx({ ui });
    await cmds.handleMenu(ctx);
    expect(selectCalls.map((call) => call.title)).toEqual([
      "Sandbox",
      "Sandbox › Network",
      "Sandbox",
    ]);
    expect(selectCalls[1].options).toContain("Back");
  });

  it("Inspect menu routes Status, Policy summary, and Explain path/host", async () => {
    const { ui, messages, selectCalls, inputCalls } = makeUI({
      selectReturns: [
        "Inspect…",
        "Status",
        "Inspect…",
        "Policy summary",
        "Inspect…",
        "Explain path/host…",
        "Explain",
        undefined,
      ],
      inputReturns: ["/tmp/test.txt"],
    });
    const ctx = makeCtx({ ui });
    await cmds.handleMenu(ctx);
    expect(selectCalls[1].options).toEqual([
      "Status",
      "Policy summary",
      "Explain path/host…",
      "Back",
    ]);
    expect(inputCalls).toEqual([
      { title: "Explain sandbox decision", placeholder: "path or host" },
    ]);
    expect(messages.map((message) => message.text).join("\n")).toMatch(
      /sandbox:|Sandbox Policy Summary|would be allowed/,
    );
  });

  it("Filesystem menu grants read, grants write, and revokes through leaf handlers", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-menu-fs-"));
    try {
      const readPath = path.join(tmpDir, "read.txt");
      const writePath = path.join(tmpDir, "write.txt");
      fs.writeFileSync(readPath, "");
      fs.writeFileSync(writePath, "");
      const { ui } = makeUI({
        selectReturns: [
          "Filesystem…",
          "Allow read…",
          "Allow",
          "Filesystem…",
          "Allow write…",
          "Allow",
          "Filesystem…",
          "Revoke grant…",
          `read ${path.resolve(readPath)}`,
          undefined,
        ],
        inputReturns: [readPath, writePath],
      });
      const ctx = makeCtx({ ui, cwd: tmpDir });
      await cmds.handleMenu(ctx);
      const state = cmds.getSessionState();
      expect(state.sessionAllowedReadPaths.has(readPath)).toBe(false);
      expect([...state.sessionAllowedWritePaths]).toEqual([
        fs.realpathSync(writePath),
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Filesystem revoke Back returns to the parent menu", async () => {
    cmds.handleAllowFs(makeCtx(), "read", "/tmp/read.txt");
    const { ui, selectCalls } = makeUI({
      selectReturns: ["Filesystem…", "Revoke grant…", "Back", undefined],
    });
    const ctx = makeCtx({ ui });
    await cmds.handleMenu(ctx);
    expect(selectCalls.map((call) => call.title)).toEqual([
      "Sandbox",
      "Sandbox › Filesystem",
      "Revoke filesystem grant",
      "Sandbox",
    ]);
    expect(cmds.getSessionState().sessionAllowedReadPaths.size).toBe(1);
  });

  it("Network menu allows and revokes hosts through leaf handlers", async () => {
    const { ui } = makeUI({
      selectReturns: [
        "Network…",
        "Allow host…",
        "Allow",
        "Network…",
        "Revoke host…",
        "example.com",
        undefined,
      ],
      inputReturns: ["example.com"],
    });
    const ctx = makeCtx({ ui });
    await cmds.handleMenu(ctx);
    expect(cmds.getSessionState().sessionAllowedHosts.has("example.com")).toBe(
      false,
    );
  });

  it("Network menu toggles filtering with permission prompt", async () => {
    const { ui, selectCalls } = makeUI({
      selectReturns: ["Network…", "Disable filtering", "Allow", undefined],
    });
    const ctx = makeCtx({ ui });
    await cmds.handleMenu(ctx);
    expect(cmds.getSessionState().networkOff).toBe(true);
    expect(selectCalls[2].title).toMatch(/Disable network filtering/);
    expect(selectCalls[2].options).toEqual(["Allow", "Block"]);
  });

  it("Session menu toggles sandbox with permission prompt", async () => {
    const { ui, selectCalls } = makeUI({
      selectReturns: ["Session…", "Disable sandbox", "Allow", undefined],
    });
    const ctx = makeCtx({ ui });
    await cmds.handleMenu(ctx);
    expect(cmds.getSessionState().sandboxOff).toBe(true);
    expect(selectCalls[2].title).toMatch(/Disable sandbox/);
    expect(selectCalls[2].options).toEqual(["Allow", "Block"]);
  });

  it("Reload uses permission prompt", async () => {
    const { ui, messages, selectCalls } = makeUI({
      selectReturns: ["Reload", "Allow", undefined],
    });
    const ctx = makeCtx({ ui });
    await cmds.handleMenu(ctx);
    expect(selectCalls[1].title).toMatch(/Reload config/);
    expect(selectCalls[1].options).toEqual(["Allow", "Block"]);
    expect(messages[0].text).toMatch(/reloaded/i);
  });

  it("menu does not include persisted flows", async () => {
    const { ui, selectCalls } = makeUI({
      selectReturns: ["Network…", undefined, undefined],
    });
    const ctx = makeCtx({ ui });
    await cmds.handleMenu(ctx);
    const options = selectCalls.flatMap((call) => call.options);
    expect(options).not.toContain("Allow host persistently");
    expect(options).not.toContain("Revoke persisted host");
    expect(options).not.toContain(expect.stringMatching(/persist/i));
  });
});
