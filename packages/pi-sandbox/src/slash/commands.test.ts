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

function makeUI(): {
  ui: SubcommandContext["ui"];
  messages: Array<{ text: string; level?: string }>;
} {
  const messages: Array<{ text: string; level?: string }> = [];
  const ui: SubcommandContext["ui"] = {
    notify: (text, level) => messages.push({ text, level }),
  };
  return { ui, messages };
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
  it("empty string → empty subcommand", () => {
    const r = parseArgs("");
    expect(r.subcommand).toBe("");
  });

  it("whitespace only → empty subcommand", () => {
    const r = parseArgs("   ");
    expect(r.subcommand).toBe("");
  });

  it("'status' → subcommand=status", () => {
    const r = parseArgs("status");
    expect(r.subcommand).toBe("status");
  });

  it("'reload' → subcommand=reload", () => {
    const r = parseArgs("reload");
    expect(r.subcommand).toBe("reload");
  });

  it("'why /some/path' → subcommand=why, target=/some/path", () => {
    const r = parseArgs("why /some/path");
    expect(r.subcommand).toBe("why");
    expect(r.target).toBe("/some/path");
  });

  it("'why evil.com' → subcommand=why, target=evil.com", () => {
    const r = parseArgs("why evil.com");
    expect(r.subcommand).toBe("why");
    expect(r.target).toBe("evil.com");
  });

  it("'allow github.com' → subcommand=allow, hosts=[github.com], persist=false", () => {
    const r = parseArgs("allow github.com");
    expect(r.subcommand).toBe("allow");
    expect(r.hosts).toEqual(["github.com"]);
    expect(r.persist).toBe(false);
  });

  it("'allow a.com b.com c.com' → multi-host", () => {
    const r = parseArgs("allow a.com b.com c.com");
    expect(r.hosts).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("'allow --persist github.com' → persist=project", () => {
    const r = parseArgs("allow --persist github.com");
    expect(r.persist).toBe("project");
    expect(r.hosts).toEqual(["github.com"]);
  });

  it("'allow --persist=user github.com' → persist=user", () => {
    const r = parseArgs("allow --persist=user github.com");
    expect(r.persist).toBe("user");
    expect(r.hosts).toEqual(["github.com"]);
  });

  it("'revoke github.com' → subcommand=revoke, target=github.com", () => {
    const r = parseArgs("revoke github.com");
    expect(r.subcommand).toBe("revoke");
    expect(r.target).toBe("github.com");
  });

  it("'revoke --persist github.com' → persist=project", () => {
    const r = parseArgs("revoke --persist github.com");
    expect(r.persist).toBe("project");
    expect(r.target).toBe("github.com");
  });

  it("'network off' → subcommand=network, target=off", () => {
    const r = parseArgs("network off");
    expect(r.subcommand).toBe("network");
    expect(r.target).toBe("off");
  });

  it("'network on' → subcommand=network, target=on", () => {
    const r = parseArgs("network on");
    expect(r.subcommand).toBe("network");
    expect(r.target).toBe("on");
  });

  it("'on' → subcommand=on", () => {
    expect(parseArgs("on").subcommand).toBe("on");
  });

  it("'off' → subcommand=off", () => {
    expect(parseArgs("off").subcommand).toBe("off");
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

  it("accepts a multi-part hostname", () => {
    expect(isValidHost("api.github.com")).toBe(true);
  });

  it("rejects a CIDR range (slash present)", () => {
    expect(isValidHost("192.168.0.0/24")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidHost("")).toBe(false);
  });

  it("rejects a wildcard-only entry without domain", () => {
    expect(isValidHost("*.")).toBe(false);
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

  it("adds multiple hosts in one call", () => {
    const { ui } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleAllow(ctx, ["a.com", "b.com", "c.com"], false);
    const state = cmds.getSessionState();
    expect(state.sessionAllowedHosts.has("a.com")).toBe(true);
    expect(state.sessionAllowedHosts.has("b.com")).toBe(true);
    expect(state.sessionAllowedHosts.has("c.com")).toBe(true);
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

  it("notifies when host not in session grants", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleRevoke(ctx, "nothere.com", false);
    expect(messages[0].text).toMatch(/not found/i);
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

  it("network off emits a warning", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleNetworkOff(ctx);
    expect(messages[0].level).toBe("warning");
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

  it("off emits a warning", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleOff(ctx);
    expect(messages[0].level).toBe("warning");
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

  it("mentions network disabled when networkOff=true", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleNetworkOff(ctx);
    messages.length = 0;
    cmds.handleStatus(ctx);
    expect(messages[0].text).toMatch(/network filtering disabled/i);
  });

  it("shows session grant count", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleAllow(ctx, ["x.com"], false);
    messages.length = 0;
    cmds.handleStatus(ctx);
    expect(messages[0].text).toMatch(/session grants=1/);
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
    expect(text).toMatch(/Session grants/);
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

  it("calls reloadPolicy and prints the fixed success message", () => {
    const { ui, messages } = makeUI();
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
    const ctx: SubcommandContext = { ui, policyManager, cwd: os.tmpdir() };
    cmds.handleReload(ctx);
    expect(reloadCalled).toBe(true);
    expect(messages[0].text).toBe(
      "Sandbox config reloaded. Run /sandbox status for current state.",
    );
  });

  it("prints the same fixed message even when policy has not changed", () => {
    const { ui, messages } = makeUI();
    const policy = makePolicy();
    const policyManager: PolicyManager = {
      getPolicy: () => policy,
      loadPolicy: (_cwd) => policy,
      reloadPolicy: (_cwd) => policy,
      subscribe: () => () => {},
    };
    const ctx: SubcommandContext = { ui, policyManager, cwd: os.tmpdir() };
    cmds.handleReload(ctx);
    expect(messages[0].text).toBe(
      "Sandbox config reloaded. Run /sandbox status for current state.",
    );
  });

  it("surfaces error with file path and reason when reloadPolicy throws", () => {
    const { ui, messages } = makeUI();
    const policy = makePolicy();
    const configPath = "/home/user/.pi/agent/sandbox.json";
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

  it("network on emits sandbox:audit", () => {
    const { events, emitted } = makeEvents();
    const ctx = makeCtx({ events });
    cmds.handleNetworkOn(ctx);
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

  it("sandbox on emits sandbox:audit", () => {
    const { events, emitted } = makeEvents();
    const ctx = makeCtx({ events });
    cmds.handleOn(ctx);
    expect(
      emitted.filter((e) => e.event === "sandbox:audit").length,
    ).toBeGreaterThan(0);
  });

  it("every mutation also emits sandbox:policy-changed", () => {
    const { events, emitted } = makeEvents();
    const { ui } = makeUI();
    const ctx = makeCtx({ ui, events });
    cmds.handleAllow(ctx, ["x.com"], false);
    expect(
      emitted.filter((e) => e.event === "sandbox:policy-changed").length,
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
  let cmds: ReturnType<typeof createSlashCommands>;

  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  it("empty prefix → all subcommands", () => {
    const pm = makePolicyManager(makePolicy());
    const values = completionValues(getArgumentCompletions("", pm));
    expect(values).toContain("status");
    expect(values).toContain("allow");
    expect(values).toContain("revoke");
  });

  it("partial subcommand prefix → filtered list", () => {
    const pm = makePolicyManager(makePolicy());
    const values = completionValues(getArgumentCompletions("st", pm));
    expect(values).toContain("status");
    expect(values).not.toContain("reload");
  });

  it("'allow ' → recently-blocked hosts", () => {
    const { events } = makeEvents();
    const pipeline = createAuditPipeline();
    pipeline.recordAudit(
      { kind: "network", decision: "blocked", host: "blocked.example.com" },
      { events },
    );
    const pm = makePolicyManager(makePolicy());
    const values = completionValues(
      getArgumentCompletions(
        "allow ",
        pm,
        undefined,
        pipeline.getRecentBlockedHosts,
      ),
    );
    expect(values).toContain("blocked.example.com");
  });

  it("'allow ' → does not suggest already-typed hosts", () => {
    const { events } = makeEvents();
    const pipeline = createAuditPipeline();
    pipeline.recordAudit(
      { kind: "network", decision: "blocked", host: "already.com" },
      { events },
    );
    const pm = makePolicyManager(makePolicy());
    const values = completionValues(
      getArgumentCompletions(
        "allow already.com ",
        pm,
        undefined,
        pipeline.getRecentBlockedHosts,
      ),
    );
    expect(values).not.toContain("already.com");
  });

  it("'revoke ' → session grants and config hosts", () => {
    const { ui } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleAllow(ctx, ["session.example.com"], false);

    const pm = makePolicyManager(makePolicy());
    const values = completionValues(getArgumentCompletions("revoke ", pm));
    expect(values).toContain("github.com");
  });

  it("'network ' → on/off", () => {
    const pm = makePolicyManager(makePolicy());
    const values = completionValues(getArgumentCompletions("network ", pm));
    expect(values).toContain("on");
    expect(values).toContain("off");
  });

  it("'network o' → on/off", () => {
    const pm = makePolicyManager(makePolicy());
    const values = completionValues(getArgumentCompletions("network o", pm));
    expect(values).toContain("on");
    expect(values).toContain("off");
  });

  it("unknown subcommand returns null (defer to default completion)", () => {
    const pm = makePolicyManager(makePolicy());
    expect(getArgumentCompletions("why ", pm)).toBeNull();
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

  it("empty args → summary", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.dispatch("", ctx);
    expect(messages[0].text).toMatch(/Sandbox Policy Summary/);
  });

  it("'status' → one-liner", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.dispatch("status", ctx);
    expect(messages[0].text).toMatch(/sandbox:/i);
    expect(messages[0].text).not.toMatch(/\n/);
  });

  it("'off' → disables sandbox", () => {
    const ctx = makeCtx();
    cmds.dispatch("off", ctx);
    expect(cmds.getSessionState().sandboxOff).toBe(true);
  });

  it("'on' → re-enables sandbox", () => {
    const ctx = makeCtx();
    cmds.dispatch("off", ctx);
    cmds.dispatch("on", ctx);
    expect(cmds.getSessionState().sandboxOff).toBe(false);
  });

  it("'network off' → disables network", () => {
    const ctx = makeCtx();
    cmds.dispatch("network off", ctx);
    expect(cmds.getSessionState().networkOff).toBe(true);
  });

  it("'network on' → re-enables network", () => {
    const ctx = makeCtx();
    cmds.dispatch("network off", ctx);
    cmds.dispatch("network on", ctx);
    expect(cmds.getSessionState().networkOff).toBe(false);
  });

  it("'allow github.com' → session grant", () => {
    const ctx = makeCtx();
    cmds.dispatch("allow github.com", ctx);
    expect(cmds.getSessionState().sessionAllowedHosts.has("github.com")).toBe(
      true,
    );
  });

  it("'allow 192.168.0.0/24' → error, no state change", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.dispatch("allow 192.168.0.0/24", ctx);
    expect(messages[0].level).toBe("error");
    expect(cmds.getSessionState().sessionAllowedHosts.size).toBe(0);
  });

  it("unknown subcommand → error message", () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.dispatch("notacommand", ctx);
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

  it("removeHostFromPersistedFile returns false when host not in file", () => {
    const configPath = path.join(tmpDir, "sandbox.json");
    fs.writeFileSync(configPath, '{ "network": { "allow": ["other.com"] } }');

    const removed = removeHostFromPersistedFile(configPath, "nothere.com");
    expect(removed).toBe(false);
  });

  it("removeHostFromPersistedFile returns false when file does not exist", () => {
    const configPath = path.join(tmpDir, "nonexistent.json");
    const removed = removeHostFromPersistedFile(configPath, "x.com");
    expect(removed).toBe(false);
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

  it("does not duplicate hosts when called twice with the same host", () => {
    const filePath = path.join(tmpDir, "sandbox.json");
    writeHostsToPersisted(filePath, ["github.com"]);
    writeHostsToPersisted(filePath, ["github.com"]);

    const src = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(src.replace(/\/\/.*$/gm, "").trim());
    const allow: string[] = parsed.network.allow;
    expect(allow.filter((h: string) => h === "github.com")).toHaveLength(1);
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

  it("allowed host in config → reports allowed by config", async () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    await cmds.handleWhy(ctx, "github.com");
    expect(messages[0].text).toMatch(/allowed by config/);
  });

  it("wildcard host in config → reports allowed by config", async () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    await cmds.handleWhy(ctx, "api.github.com");
    expect(messages[0].text).toMatch(/allowed by config/);
  });

  it("host in session grants → reports allowed by session grant", async () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleAllow(ctx, ["session.example.com"], false);
    messages.length = 0;
    await cmds.handleWhy(ctx, "session.example.com");
    expect(messages[0].text).toMatch(/session grant/);
  });

  it("unknown host → reports would be blocked", async () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    await cmds.handleWhy(ctx, "unknown.example.com");
    expect(messages[0].text).toMatch(/blocked/);
  });

  it("networkOff → reports allowed (network filtering off)", async () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleNetworkOff(ctx);
    messages.length = 0;
    await cmds.handleWhy(ctx, "unknown.example.com");
    expect(messages[0].text).toMatch(/allowed.*network filtering off/);
  });

  it("sandboxOff → reports allowed (sandbox disabled)", async () => {
    const { ui, messages } = makeUI();
    const ctx = makeCtx({ ui });
    cmds.handleOff(ctx);
    messages.length = 0;
    await cmds.handleWhy(ctx, "unknown.example.com");
    expect(messages[0].text).toMatch(/allowed.*sandbox disabled/);
  });

  it("path in fs.allowRead → reports would be allowed", async () => {
    const { ui, messages } = makeUI();
    const policy = makePolicy({
      fs: { allowRead: ["/tmp"], allowWrite: [], denyPatterns: [] },
    });
    const ctx = makeCtx({ ui, policyManager: makePolicyManager(policy) });
    await cmds.handleWhy(ctx, "/tmp/somefile.txt");
    expect(messages[0].text).toMatch(/would be allowed/);
  });

  it("path matching denyPattern → reports blocked by denyPattern", async () => {
    const { ui, messages } = makeUI();
    const policy = makePolicy({
      fs: { allowRead: ["/tmp"], allowWrite: [], denyPatterns: ["**/.env"] },
    });
    const ctx = makeCtx({
      ui,
      policyManager: makePolicyManager(policy),
      cwd: "/tmp",
    });
    await cmds.handleWhy(ctx, "/tmp/.env");
    expect(messages[0].text).toMatch(/blocked by denyPattern/);
  });

  it("path not in fs.allowRead → reports blocked", async () => {
    const { ui, messages } = makeUI();
    const policy = makePolicy({
      fs: { allowRead: ["/allowed"], allowWrite: [], denyPatterns: [] },
    });
    const ctx = makeCtx({ ui, policyManager: makePolicyManager(policy) });
    await cmds.handleWhy(ctx, "/not-allowed/file.txt");
    expect(messages[0].text).toMatch(/blocked/);
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

describe("handleAllow --persist=user with custom home dir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-user-persist-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes to the user config path (injected via direct writeHostsToPersisted call)", () => {
    const userConfigPath = path.join(tmpDir, ".pi", "agent", "sandbox.json");

    writeHostsToPersisted(userConfigPath, ["user-host.com"]);

    expect(fs.existsSync(userConfigPath)).toBe(true);
    const written = fs.readFileSync(userConfigPath, "utf8");
    expect(written).toContain("user-host.com");
  });

  it("does not duplicate when persist=user called twice for same host", () => {
    const userConfigPath = path.join(tmpDir, ".pi", "agent", "sandbox.json");

    writeHostsToPersisted(userConfigPath, ["dedup.com"]);
    writeHostsToPersisted(userConfigPath, ["dedup.com"]);

    const src = fs.readFileSync(userConfigPath, "utf8");
    const occurrences = (src.match(/dedup\.com/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

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

  it("each audit event has a distinct host (not comma-joined)", () => {
    const { events, emitted } = makeEvents();
    const { ui } = makeUI();
    const ctx = makeCtx({ ui, events });

    cmds.handleAllow(ctx, ["x.com", "y.com"], false);

    const auditEvents = emitted.filter((e) => e.event === "sandbox:audit");
    for (const ev of auditEvents) {
      const host = (ev.payload as Record<string, unknown>).host as string;
      expect(host).not.toContain(",");
    }
  });

  it("network off audit event includes rule=network-off", () => {
    const { events, emitted } = makeEvents();
    const ctx = makeCtx({ events });

    cmds.handleNetworkOff(ctx);

    const auditEvents = emitted.filter((e) => e.event === "sandbox:audit");
    expect(auditEvents).toHaveLength(1);
    expect((auditEvents[0].payload as Record<string, unknown>).rule).toBe(
      "network-off",
    );
  });

  it("sandbox off audit event includes rule=sandbox-off", () => {
    const { events, emitted } = makeEvents();
    const ctx = makeCtx({ events });

    cmds.handleOff(ctx);

    const auditEvents = emitted.filter((e) => e.event === "sandbox:audit");
    expect(auditEvents).toHaveLength(1);
    expect((auditEvents[0].payload as Record<string, unknown>).rule).toBe(
      "sandbox-off",
    );
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
