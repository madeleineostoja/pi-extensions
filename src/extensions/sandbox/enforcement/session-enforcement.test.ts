import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createSlashCommands,
  type SubcommandContext,
} from "../slash/commands.js";
import { createAuditPipeline } from "../audit/audit.js";
import { applySessionOverrides } from "../policy/effective.js";
import { createToolGate, BLOCK_REASON, type ToolGate } from "./toolGate.js";
import { createUserBashHandler } from "./subprocess.js";
import { createCaps } from "./caps.js";
import type { Policy } from "../policy/defaults.js";
import type { ManifestContext } from "./caps.js";
import type { AuditEntry } from "../audit/schema.js";
import type { ToolCallEvent } from "./toolGate.js";
import type { UserBashEvent } from "@earendil-works/pi-coding-agent";

function makeEvent(
  toolName: string,
  input: Record<string, unknown>,
): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "test",
    toolName,
    input,
  } as ToolCallEvent;
}

function makeUserBashEvent(command: string, cwd: string): UserBashEvent {
  return {
    type: "user_bash",
    command,
    cwd,
    excludeFromContext: false,
  };
}

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    enabled: true,
    fs: {
      allowRead: [],
      allowWrite: [],
      denyPatterns: ["**/.env", "**/.ssh/**"],
    },
    network: {
      mode: "non-interactive-only",
      allow: ["github.com"],
    },
    audit: { log: false, logFile: "/tmp/audit.jsonl" },
    enforcement: { requireKernelSandbox: false },
    ...overrides,
  };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-sess-enf-test-"));
}

function makeCtx(cwd: string): ManifestContext {
  return {
    mode: "rpc",
    cwd,
    platform: "linux",
    ui: { notify: vi.fn() },
  };
}

function makeSubcommandCtx(cwd: string): SubcommandContext {
  const policy = makePolicy();
  return {
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      confirm: vi.fn(),
    },
    policyManager: {
      getPolicy: () => policy,
      loadPolicy: () => policy,
      reloadPolicy: () => policy,
      subscribe: () => () => {},
    } as SubcommandContext["policyManager"],
    cwd,
  };
}

describe("session enforcement — /sandbox off", () => {
  let tmpDir: string;
  let gate: ToolGate;
  let cmds: ReturnType<typeof createSlashCommands>;

  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
    tmpDir = makeTmpDir();
    const policy = makePolicy({
      fs: {
        allowRead: [],
        allowWrite: [],
        denyPatterns: ["**/.env", "**/.ssh/**"],
      },
    });
    gate = createToolGate({
      getPolicy: () => policy,
      getSession: () => cmds.getSessionState(),
      ctx: makeCtx(tmpDir),
    });
  });

  afterEach(() => {
    gate.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blocks /etc/passwd before sandbox off", async () => {
    const result = await gate.handleToolCall(
      makeEvent("read", { path: "/etc/passwd" }),
    );
    expect(result).toEqual({ block: true, reason: BLOCK_REASON });
  });

  it("allows /etc/passwd after dispatch('off')", async () => {
    const ctx = makeSubcommandCtx(tmpDir);
    cmds.dispatch("off", ctx);
    const result = await gate.handleToolCall(
      makeEvent("read", { path: "/etc/passwd" }),
    );
    expect(result).toBeUndefined();
  });

  it("blocks again after dispatch('on')", async () => {
    const ctx = makeSubcommandCtx(tmpDir);
    cmds.dispatch("off", ctx);
    cmds.dispatch("on", ctx);
    const result = await gate.handleToolCall(
      makeEvent("read", { path: "/etc/passwd" }),
    );
    expect(result).toEqual({ block: true, reason: BLOCK_REASON });
  });
});

describe("session enforcement — /sandbox allow host <host>", () => {
  let tmpDir: string;
  let cmds: ReturnType<typeof createSlashCommands>;

  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("manifest includes example.com after dispatch('allow host example.com')", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    cmds.dispatch("allow host example.com", ctx);

    const policy = makePolicy();
    const session = cmds.getSessionState();
    const effective = applySessionOverrides(policy, session);
    const manifest = createCaps().buildManifest(effective, makeCtx(tmpDir));

    expect(manifest.network?.allow_domain).toContain("example.com");
  });

  it("manifest still contains configured hosts after session allow", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    cmds.dispatch("allow host example.com", ctx);

    const policy = makePolicy();
    const session = cmds.getSessionState();
    const effective = applySessionOverrides(policy, session);
    const manifest = createCaps().buildManifest(effective, makeCtx(tmpDir));

    expect(manifest.network?.allow_domain).toContain("github.com");
  });
});

describe("session enforcement — /sandbox network off", () => {
  let tmpDir: string;
  let cmds: ReturnType<typeof createSlashCommands>;

  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("manifest omits the network field after dispatch('network off') (allow all)", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    cmds.dispatch("network off", ctx);

    const policy = makePolicy();
    const session = cmds.getSessionState();
    const effective = applySessionOverrides(policy, session);
    const manifest = createCaps().buildManifest(effective, makeCtx(tmpDir));

    expect(manifest.network).toBeUndefined();
  });
});

describe("session enforcement — /sandbox revoke host <host>", () => {
  let tmpDir: string;
  let cmds: ReturnType<typeof createSlashCommands>;

  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("manifest no longer contains example.com after revoke following session allow", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    cmds.dispatch("allow host example.com", ctx);

    let policy = makePolicy();
    let session = cmds.getSessionState();
    let effective = applySessionOverrides(policy, session);
    let manifest = createCaps().buildManifest(effective, makeCtx(tmpDir));
    expect(manifest.network?.allow_domain).toContain("example.com");

    cmds.dispatch("revoke host example.com", ctx);

    policy = makePolicy();
    session = cmds.getSessionState();
    effective = applySessionOverrides(policy, session);
    manifest = createCaps().buildManifest(effective, makeCtx(tmpDir));
    expect(manifest.network?.allow_domain ?? []).not.toContain("example.com");
  });
});

describe("session enforcement — subscribers fire on mutation", () => {
  let tmpDir: string;
  let cmds: ReturnType<typeof createSlashCommands>;

  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("subscribeSessionChange fires exactly once on dispatch('off')", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    const listener = vi.fn();
    const unsub = cmds.subscribeSessionChange(listener);
    try {
      cmds.dispatch("off", ctx);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsub();
    }
  });

  it("subscribeSessionChange fires exactly once on dispatch('on')", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    const listener = vi.fn();
    const unsub = cmds.subscribeSessionChange(listener);
    try {
      cmds.dispatch("on", ctx);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsub();
    }
  });

  it("subscribeSessionChange fires exactly once on dispatch('network off')", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    const listener = vi.fn();
    const unsub = cmds.subscribeSessionChange(listener);
    try {
      cmds.dispatch("network off", ctx);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsub();
    }
  });

  it("subscribeSessionChange fires exactly once on dispatch('network on')", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    const listener = vi.fn();
    const unsub = cmds.subscribeSessionChange(listener);
    try {
      cmds.dispatch("network on", ctx);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsub();
    }
  });

  it("subscribeSessionChange fires exactly once on dispatch('allow host example.com') (session path)", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    const listener = vi.fn();
    const unsub = cmds.subscribeSessionChange(listener);
    try {
      cmds.dispatch("allow host example.com", ctx);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsub();
    }
  });

  it("subscribeSessionChange fires exactly once on dispatch('revoke host example.com') after allow", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    cmds.dispatch("allow host example.com", ctx);

    const listener = vi.fn();
    const unsub = cmds.subscribeSessionChange(listener);
    try {
      cmds.dispatch("revoke host example.com", ctx);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsub();
    }
  });

  it("multiple subscribers all fire on a single mutation", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    const l1 = vi.fn();
    const l2 = vi.fn();
    const unsub1 = cmds.subscribeSessionChange(l1);
    const unsub2 = cmds.subscribeSessionChange(l2);
    try {
      cmds.dispatch("off", ctx);
      expect(l1).toHaveBeenCalledTimes(1);
      expect(l2).toHaveBeenCalledTimes(1);
    } finally {
      unsub1();
      unsub2();
    }
  });

  it("unsubscribed listener does not fire after unsubscribe", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    const listener = vi.fn();
    const unsub = cmds.subscribeSessionChange(listener);
    unsub();
    cmds.dispatch("off", ctx);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("session enforcement — createUserBashHandler honors /sandbox off", () => {
  let tmpDir: string;
  let cmds: ReturnType<typeof createSlashCommands>;

  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when sandbox is off", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    cmds.dispatch("off", ctx);

    const policy = makePolicy();
    const nonoPath = "/usr/local/bin/nono";
    const handler = createUserBashHandler(
      () => policy,
      makeCtx(tmpDir),
      nonoPath,
      undefined,
      () => cmds.getSessionState(),
    );

    const result = handler(makeUserBashEvent("cat /etc/passwd", tmpDir));

    expect(result).toBeUndefined();
  });

  it("emits audit entry with rule session:sandbox-off when sandbox is off", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    cmds.dispatch("off", ctx);

    const policy = makePolicy();
    const nonoPath = "/usr/local/bin/nono";
    const auditEntries: Omit<AuditEntry, "ts">[] = [];
    const handler = createUserBashHandler(
      () => policy,
      makeCtx(tmpDir),
      nonoPath,
      (entry) => auditEntries.push(entry),
      () => cmds.getSessionState(),
    );

    handler(makeUserBashEvent("cat /etc/passwd", tmpDir));

    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({
      kind: "exec",
      decision: "allowed",
      rule: "session:sandbox-off",
    });
  });

  it("returns custom operations when sandbox is on", () => {
    const policy = makePolicy();
    const nonoPath = "/usr/local/bin/nono";
    const handler = createUserBashHandler(
      () => policy,
      makeCtx(tmpDir),
      nonoPath,
      undefined,
      () => cmds.getSessionState(),
    );

    const result = handler(makeUserBashEvent("cat /etc/passwd", tmpDir));

    expect(result?.operations?.exec).toEqual(expect.any(Function));
  });

  it("returns custom operations again after dispatch('on')", () => {
    const ctx = makeSubcommandCtx(tmpDir);
    cmds.dispatch("off", ctx);
    cmds.dispatch("on", ctx);

    const policy = makePolicy();
    const nonoPath = "/usr/local/bin/nono";
    const handler = createUserBashHandler(
      () => policy,
      makeCtx(tmpDir),
      nonoPath,
      undefined,
      () => cmds.getSessionState(),
    );

    const result = handler(makeUserBashEvent("cat /etc/passwd", tmpDir));

    expect(result?.operations?.exec).toEqual(expect.any(Function));
  });
});
