import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(_execFile);

import { createAuditPipeline } from "./audit.js";
import type { AuditPipeline } from "./audit.js";
import type { SandboxAuditEvent, SandboxPolicyChangedEvent } from "./schema.js";
import { createAuditEmitter } from "./events.js";
import { createLogWriter } from "./log.js";

let recordAudit: AuditPipeline["recordAudit"];

beforeEach(() => {
  ({ recordAudit } = createAuditPipeline());
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-audit-test-"));
}

function makeEvents() {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const target = {
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
    },
  };
  return { target, emitted };
}

// ---------------------------------------------------------------------------
// Schema validation: each kind × decision combination
// ---------------------------------------------------------------------------

describe("entry schema — kind × decision combinations", () => {
  const combinations: Array<{
    kind: "fs" | "network" | "exec" | "policy-change";
    decision: "allowed" | "blocked" | "granted" | "revoked";
  }> = [
    { kind: "fs", decision: "allowed" },
    { kind: "fs", decision: "blocked" },
    { kind: "network", decision: "allowed" },
    { kind: "network", decision: "blocked" },
    { kind: "exec", decision: "allowed" },
    { kind: "exec", decision: "blocked" },
    { kind: "policy-change", decision: "granted" },
    { kind: "policy-change", decision: "revoked" },
  ];

  for (const { kind, decision } of combinations) {
    it(`kind=${kind} decision=${decision} emits a sandbox:audit event`, () => {
      const { target: t, emitted: e } = makeEvents();
      recordAudit({ kind, decision }, { events: t });
      const auditEvents = e.filter((x) => x.event === "sandbox:audit");
      expect(auditEvents).toHaveLength(1);
      const payload = auditEvents[0].payload as SandboxAuditEvent;
      expect(payload.kind).toBe(kind);
      expect(payload.decision).toBe(decision);
      expect(typeof payload.ts).toBe("number");
    });
  }

  it("fs entry carries path when provided", () => {
    const { target: t, emitted: e } = makeEvents();
    recordAudit(
      { kind: "fs", decision: "blocked", path: "/secret/.env", tool: "read" },
      { events: t },
    );
    const payload = e[0].payload as SandboxAuditEvent;
    expect(payload.path).toBe("/secret/.env");
    expect(payload.tool).toBe("read");
  });

  it("network entry carries host when provided", () => {
    const { target: t, emitted: e } = makeEvents();
    recordAudit(
      { kind: "network", decision: "blocked", host: "evil.com" },
      {
        events: t,
      },
    );
    const payload = e[0].payload as SandboxAuditEvent;
    expect(payload.host).toBe("evil.com");
  });

  it("policy-change entry carries scope and source", () => {
    const { target: t, emitted: e } = makeEvents();
    recordAudit(
      {
        kind: "policy-change",
        decision: "granted",
        scope: "session",
        source: "command",
      },
      { events: t },
    );
    const payload = e[0].payload as SandboxAuditEvent;
    expect(payload.scope).toBe("session");
    expect(payload.source).toBe("command");
  });
});

// ---------------------------------------------------------------------------
// sandbox:policy-changed event
// ---------------------------------------------------------------------------

describe("sandbox:policy-changed event", () => {
  it("emits sandbox:policy-changed for policy-change kind entries", () => {
    const { target, emitted } = makeEvents();
    recordAudit(
      {
        kind: "policy-change",
        decision: "granted",
        scope: "persisted",
        source: "command",
      },
      { events: target },
    );

    const policyChangedEvents = emitted.filter(
      (x) => x.event === "sandbox:policy-changed",
    );
    expect(policyChangedEvents).toHaveLength(1);
    const payload = policyChangedEvents[0].payload as SandboxPolicyChangedEvent;
    expect(payload.scope).toBe("persisted");
    expect(payload.source).toBe("command");
    expect(typeof payload.ts).toBe("number");
  });

  it("does NOT emit sandbox:policy-changed for non-policy-change kinds", () => {
    const { target, emitted } = makeEvents();
    recordAudit({ kind: "fs", decision: "blocked" }, { events: target });
    recordAudit({ kind: "exec", decision: "allowed" }, { events: target });
    recordAudit({ kind: "network", decision: "blocked" }, { events: target });

    const policyChangedEvents = emitted.filter(
      (x) => x.event === "sandbox:policy-changed",
    );
    expect(policyChangedEvents).toHaveLength(0);
  });

  it("emits both sandbox:audit and sandbox:policy-changed for policy-change entries", () => {
    const { target, emitted } = makeEvents();
    recordAudit(
      { kind: "policy-change", decision: "revoked" },
      {
        events: target,
      },
    );

    expect(emitted.filter((x) => x.event === "sandbox:audit")).toHaveLength(1);
    expect(
      emitted.filter((x) => x.event === "sandbox:policy-changed"),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// JSONL file writer
// ---------------------------------------------------------------------------

describe("JSONL file writer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the log file and writes a valid JSON line", () => {
    const logFile = path.join(tmpDir, "sandbox-audit.jsonl");
    recordAudit(
      { kind: "fs", decision: "blocked", path: "/etc/passwd" },
      {
        logFile,
      },
    );

    expect(fs.existsSync(logFile)).toBe(true);
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as SandboxAuditEvent;
    expect(entry.kind).toBe("fs");
    expect(entry.decision).toBe("blocked");
    expect(entry.path).toBe("/etc/passwd");
  });

  it("appends multiple entries, one per line", () => {
    const logFile = path.join(tmpDir, "sandbox-audit.jsonl");
    recordAudit({ kind: "fs", decision: "blocked" }, { logFile });
    recordAudit({ kind: "exec", decision: "allowed" }, { logFile });
    recordAudit(
      { kind: "network", decision: "blocked", host: "bad.com" },
      {
        logFile,
      },
    );

    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).kind).toBe("fs");
    expect(JSON.parse(lines[1]).kind).toBe("exec");
    expect(JSON.parse(lines[2]).host).toBe("bad.com");
  });

  it("creates intermediate directories if they don't exist", () => {
    const logFile = path.join(tmpDir, "nested", "deep", "sandbox-audit.jsonl");
    recordAudit({ kind: "exec", decision: "allowed" }, { logFile });

    expect(fs.existsSync(logFile)).toBe(true);
  });

  it("does not write to disk when logEnabled is false", () => {
    const logFile = path.join(tmpDir, "sandbox-audit.jsonl");
    recordAudit(
      { kind: "fs", decision: "blocked" },
      {
        logFile,
        logEnabled: false,
      },
    );

    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("still emits events when logEnabled is false", () => {
    const logFile = path.join(tmpDir, "sandbox-audit.jsonl");
    const { target, emitted } = makeEvents();
    recordAudit(
      { kind: "fs", decision: "blocked" },
      {
        logFile,
        logEnabled: false,
        events: target,
      },
    );

    expect(emitted.filter((x) => x.event === "sandbox:audit")).toHaveLength(1);
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("does not write to disk when logFile is not provided", () => {
    const { target, emitted } = makeEvents();
    recordAudit({ kind: "fs", decision: "blocked" }, { events: target });

    expect(emitted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Log rotation
// ---------------------------------------------------------------------------

describe("log rotation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rotates the log file when it exceeds maxBytes", () => {
    const logFile = path.join(tmpDir, "sandbox-audit.jsonl");
    const maxBytes = 200;

    // Fill the log past the threshold
    for (let i = 0; i < 20; i++) {
      recordAudit(
        {
          kind: "fs",
          decision: "blocked",
          path: `/a/very/long/path/number/${i}`,
        },
        { logFile, maxBytes },
      );
    }

    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
  });

  it("preserves the previous file as .1 after rotation", () => {
    const logFile = path.join(tmpDir, "sandbox-audit.jsonl");
    const maxBytes = 100;

    // Write enough to force a rotation
    for (let i = 0; i < 10; i++) {
      recordAudit(
        { kind: "exec", decision: "allowed", tool: `tool-${i}` },
        {
          logFile,
          maxBytes,
        },
      );
    }

    const rotated = `${logFile}.1`;
    expect(fs.existsSync(rotated)).toBe(true);
    const lines = fs.readFileSync(rotated, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  it("respects maxFiles by not keeping more than N rotated files", () => {
    const logFile = path.join(tmpDir, "sandbox-audit.jsonl");
    const maxBytes = 50;
    const maxFiles = 2;

    for (let i = 0; i < 50; i++) {
      recordAudit(
        { kind: "fs", decision: "blocked", path: `/path/${i}` },
        {
          logFile,
          maxBytes,
          maxFiles,
        },
      );
    }

    // With maxFiles=2, .1 and .2 should exist but not .3 or higher
    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    expect(fs.existsSync(`${logFile}.2`)).toBe(true);
    expect(fs.existsSync(`${logFile}.3`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Permission-failure fallback
// ---------------------------------------------------------------------------

describe("permission-failure fallback", () => {
  let lockedDir: string;
  let logWriter: ReturnType<typeof createLogWriter>;

  beforeEach(() => {
    logWriter = createLogWriter();
    lockedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-audit-locked-"));
    fs.chmodSync(lockedDir, 0o000);
  });

  afterEach(() => {
    fs.chmodSync(lockedDir, 0o700);
    fs.rmSync(lockedDir, { recursive: true, force: true });
  });

  it("does not throw when log directory cannot be created", () => {
    const logFile = path.join(lockedDir, "subdir", "sandbox-audit.jsonl");

    expect(() =>
      logWriter.appendLogEntry(
        {
          ts: Date.now(),
          kind: "fs",
          decision: "blocked",
        } as import("./schema.js").AuditEntry,
        { logFile },
      ),
    ).not.toThrow();
  });

  it("still emits events even when the log directory is unwritable", () => {
    const { target, emitted } = makeEvents();
    const logFile = path.join(lockedDir, "subdir", "sandbox-audit.jsonl");

    recordAudit(
      { kind: "fs", decision: "blocked" },
      {
        logFile,
        events: target,
      },
    );

    expect(emitted.filter((x) => x.event === "sandbox:audit")).toHaveLength(1);
  });

  it("emits the warning exactly once even when called multiple times", () => {
    const logFile = path.join(lockedDir, "subdir", "sandbox-audit.jsonl");
    const warnings: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        if (typeof chunk === "string") warnings.push(chunk);
        return true;
      });

    try {
      logWriter.appendLogEntry(
        {
          ts: Date.now(),
          kind: "fs",
          decision: "blocked",
        } as import("./schema.js").AuditEntry,
        { logFile },
      );
      logWriter.appendLogEntry(
        {
          ts: Date.now(),
          kind: "fs",
          decision: "blocked",
        } as import("./schema.js").AuditEntry,
        { logFile },
      );
      logWriter.appendLogEntry(
        {
          ts: Date.now(),
          kind: "fs",
          decision: "blocked",
        } as import("./schema.js").AuditEntry,
        { logFile },
      );
    } finally {
      spy.mockRestore();
    }

    const sandboxWarnings = warnings.filter((w) => w.includes("pi-sandbox:"));
    expect(sandboxWarnings).toHaveLength(1);
  });

  it("two distinct log file paths produce two separate warnings (file-keyed deduplication)", () => {
    const logFile1 = path.join(lockedDir, "subdir1", "sandbox-audit.jsonl");
    const logFile2 = path.join(lockedDir, "subdir2", "sandbox-audit.jsonl");
    const warnings: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        if (typeof chunk === "string") warnings.push(chunk);
        return true;
      });

    try {
      logWriter.appendLogEntry(
        {
          ts: Date.now(),
          kind: "fs",
          decision: "blocked",
        } as import("./schema.js").AuditEntry,
        { logFile: logFile1 },
      );
      logWriter.appendLogEntry(
        {
          ts: Date.now(),
          kind: "fs",
          decision: "blocked",
        } as import("./schema.js").AuditEntry,
        { logFile: logFile2 },
      );
      // Repeat both — should not produce additional warnings
      logWriter.appendLogEntry(
        {
          ts: Date.now(),
          kind: "fs",
          decision: "blocked",
        } as import("./schema.js").AuditEntry,
        { logFile: logFile1 },
      );
      logWriter.appendLogEntry(
        {
          ts: Date.now(),
          kind: "fs",
          decision: "blocked",
        } as import("./schema.js").AuditEntry,
        { logFile: logFile2 },
      );
    } finally {
      spy.mockRestore();
    }

    const sandboxWarnings = warnings.filter((w) => w.includes("pi-sandbox:"));
    expect(sandboxWarnings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Recently-blocked hosts ring buffer
// ---------------------------------------------------------------------------

describe("recently-blocked hosts ring buffer", () => {
  let emitter: ReturnType<typeof createAuditEmitter>;

  beforeEach(() => {
    emitter = createAuditEmitter();
  });

  function makeFullEntry(
    partial: Parameters<typeof recordAudit>[0],
  ): import("./schema.js").AuditEntry {
    return { ts: Date.now(), ...partial } as import("./schema.js").AuditEntry;
  }

  it("records blocked hosts in the ring buffer", () => {
    const { target } = makeEvents();
    emitter.emitAuditEvents(
      makeFullEntry({ kind: "network", decision: "blocked", host: "evil.com" }),
      target,
    );

    expect(emitter.getRecentBlockedHosts()).toContain("evil.com");
  });

  it("does not record allowed hosts", () => {
    const { target } = makeEvents();
    emitter.emitAuditEvents(
      makeFullEntry({ kind: "network", decision: "allowed", host: "good.com" }),
      target,
    );

    expect(emitter.getRecentBlockedHosts()).not.toContain("good.com");
  });

  it("does not record blocked entries without a host", () => {
    const { target } = makeEvents();
    emitter.emitAuditEvents(
      makeFullEntry({ kind: "fs", decision: "blocked", path: "/etc/passwd" }),
      target,
    );

    expect(emitter.getRecentBlockedHosts()).toHaveLength(0);
  });

  it("caps the ring buffer at 20 entries", () => {
    const { target } = makeEvents();
    for (let i = 0; i < 25; i++) {
      emitter.emitAuditEvents(
        makeFullEntry({
          kind: "network",
          decision: "blocked",
          host: `host${i}.com`,
        }),
        target,
      );
    }

    expect(emitter.getRecentBlockedHosts().length).toBeLessThanOrEqual(20);
  });

  it("preserves the most-recent hosts (oldest evicted first)", () => {
    const { target } = makeEvents();
    for (let i = 0; i < 25; i++) {
      emitter.emitAuditEvents(
        makeFullEntry({
          kind: "network",
          decision: "blocked",
          host: `host${i}.com`,
        }),
        target,
      );
    }

    const hosts = emitter.getRecentBlockedHosts();
    expect(hosts).toContain("host24.com");
    expect(hosts).not.toContain("host0.com");
  });
});

// ---------------------------------------------------------------------------
// Concurrency: two processes append simultaneously without corrupting the log
// ---------------------------------------------------------------------------

describe("concurrent writes (O_APPEND atomicity)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("two processes writing 50 entries each produce 100 valid JSONL lines", async () => {
    const logFile = path.join(tmpDir, "concurrent-audit.jsonl");
    const count = 50;

    const inlineScript = `
      const fs = require('fs');
      const logFile = process.argv[2];
      const count = parseInt(process.argv[3], 10);
      for (let i = 0; i < count; i++) {
        const entry = JSON.stringify({ ts: Date.now(), kind: 'fs', decision: 'blocked', path: '/p/' + i });
        fs.writeFileSync(logFile, entry + '\\n', { flag: 'a', encoding: 'utf8' });
      }
    `;

    const scriptFile = path.join(tmpDir, "writer.cjs");
    fs.writeFileSync(scriptFile, inlineScript, "utf8");

    await Promise.all([
      execFile(process.execPath, [scriptFile, logFile, String(count)]),
      execFile(process.execPath, [scriptFile, logFile, String(count)]),
    ]);

    const content = fs.readFileSync(logFile, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(count * 2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// toolGate.ts onAudit hook integration
// ---------------------------------------------------------------------------

describe("toolGate onAudit hook", () => {
  it("calls onAudit with a blocked fs entry when denyPattern fires", async () => {
    const { createToolGate, BLOCK_REASON } =
      await import("../enforcement/toolGate.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tg-audit-"));
    const auditCalls: Array<Omit<SandboxAuditEvent, "ts">> = [];
    let gate: ReturnType<typeof createToolGate> | undefined;
    try {
      gate = createToolGate({
        getPolicy: () => ({
          enabled: true,
          fs: {
            allowRead: [tmpDir],
            allowWrite: [],
            denyPatterns: ["**/.env"],
          },
          network: { mode: "non-interactive-only", allow: [] },
          audit: { log: false, logFile: "/tmp/audit.jsonl" },
          enforcement: { requireKernelSandbox: false },
        }),
        ctx: {
          hasUI: false,
          cwd: tmpDir,
          platform: "linux",
          ui: { notify: () => {} },
        },
        onAudit: (entry) =>
          auditCalls.push(entry as Omit<SandboxAuditEvent, "ts">),
      });

      const envFile = path.join(tmpDir, ".env");
      fs.writeFileSync(envFile, "SECRET=x");
      const result = await gate.handleToolCall({
        type: "tool_call",
        toolCallId: "test",
        toolName: "read",
        input: { path: envFile },
      } as Parameters<typeof gate.handleToolCall>[0]);

      expect(result).toEqual({ block: true, reason: BLOCK_REASON });
      expect(auditCalls).toHaveLength(1);
      expect(auditCalls[0].kind).toBe("fs");
      expect(auditCalls[0].decision).toBe("blocked");
      expect(auditCalls[0].tool).toBe("read");
      expect(auditCalls[0].rule).toBe("denyPattern");
    } finally {
      gate?.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("calls onAudit with a blocked fs entry when allowList miss occurs", async () => {
    const { createToolGate } = await import("../enforcement/toolGate.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tg-audit-"));
    const auditCalls: Array<Omit<SandboxAuditEvent, "ts">> = [];
    let gate: ReturnType<typeof createToolGate> | undefined;
    try {
      gate = createToolGate({
        getPolicy: () => ({
          enabled: true,
          fs: { allowRead: [], allowWrite: [], denyPatterns: [] },
          network: { mode: "non-interactive-only", allow: [] },
          audit: { log: false, logFile: "/tmp/audit.jsonl" },
          enforcement: { requireKernelSandbox: false },
        }),
        ctx: {
          hasUI: false,
          cwd: tmpDir,
          platform: "linux",
          ui: { notify: () => {} },
        },
        onAudit: (entry) =>
          auditCalls.push(entry as Omit<SandboxAuditEvent, "ts">),
      });

      const file = path.join(tmpDir, "secret.txt");
      fs.writeFileSync(file, "x");
      await gate.handleToolCall({
        type: "tool_call",
        toolCallId: "test",
        toolName: "read",
        input: { path: file },
      } as Parameters<typeof gate.handleToolCall>[0]);

      expect(auditCalls).toHaveLength(1);
      expect(auditCalls[0].decision).toBe("blocked");
      expect(auditCalls[0].rule).toContain("allowList");
    } finally {
      gate?.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
