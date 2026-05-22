import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../../runtime/binary.js", () => ({
  getNonoPath: vi.fn(),
  getBinaryStatus: vi.fn().mockReturnValue({ kind: "install-failed", reason: "marker-missing" }),
}));

import * as binaryMod from "../../runtime/binary.js";
import {
  createSpawnHook,
  createUserBashHandler,
  wrapPiExec,
  initSubprocessSandbox,
  piSandboxWrappedSymbol,
  ensurePidDir,
  ensurePidExitHandler,
} from "../subprocess.js";
import type {
  SpawnHookInput,
  ExecOptions,
  ExecResult,
} from "../subprocess.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AuditEntry } from "../../audit/schema.js";
import type { Policy } from "../../policy/defaults.js";
import type { ManifestContext } from "../caps.js";

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    enabled: true,
    fs: {
      allowRead: [],
      allowWrite: [],
      denyPatterns: [],
    },
    network: {
      mode: "non-interactive-only",
      allow: ["github.com"],
    },
    audit: {
      log: true,
      logFile: "/tmp/audit.jsonl",
    },
    enforcement: { requireKernelSandbox: false },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ManifestContext> = {}): ManifestContext {
  return {
    hasUI: false,
    cwd: process.cwd(),
    platform: "linux",
    ui: { notify: vi.fn() },
    ...overrides,
  };
}

type MockPi = Pick<ExtensionAPI, "exec" | "on" | "registerTool"> & {
  events: { emit: ReturnType<typeof vi.fn> };
};

function makePi(overrides: Partial<MockPi> = {}): ExtensionAPI {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    events: { emit: vi.fn() },
    ...overrides,
  } as unknown as ExtensionAPI;
}

describe("createSpawnHook — command rewriting", () => {
  it("returns original input when nonoPath is null (fallback mode)", () => {
    const hook = createSpawnHook(() => makePolicy(), makeCtx(), null);
    const input: SpawnHookInput = { command: "ls -la", cwd: "/tmp", env: { PATH: "/usr/bin" } };
    const output = hook(input);
    expect(output).toEqual(input);
  });

  it("rewrites command to use nono run when nonoPath is provided", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sp-test-"));
    try {
      const nonoPath = "/usr/local/bin/nono";
      const hook = createSpawnHook(() => makePolicy(), makeCtx({ cwd: tmpDir }), nonoPath);
      const input: SpawnHookInput = { command: "ls -la", cwd: tmpDir };
      const output = hook(input);

      expect(output.command).toContain(nonoPath);
      expect(output.command).toContain("run");
      expect(output.command).toContain("--config");
      expect(output.command).toContain("--");
      expect(output.command).toContain("bash");
      expect(output.command).toContain("-c");
      expect(output.command).toContain("ls -la");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves cwd and env in rewritten output", () => {
    const nonoPath = "/usr/local/bin/nono";
    const env = { PATH: "/usr/bin:/usr/local/bin", HOME: "/home/user" };
    const hook = createSpawnHook(() => makePolicy(), makeCtx(), nonoPath);
    const input: SpawnHookInput = { command: "echo hello", cwd: "/workspace", env };
    const output = hook(input);

    expect(output.cwd).toBe("/workspace");
    expect(output.env).toEqual(env);
  });

  it("includes --config <tmpfile>.json in rewritten command", () => {
    const nonoPath = "/usr/bin/nono";
    const hook = createSpawnHook(() => makePolicy(), makeCtx(), nonoPath);
    const output = hook({ command: "whoami" });

    const parts = output.command.split(" ");
    const configIdx = parts.indexOf("--config");
    expect(configIdx).toBeGreaterThan(-1);
    const configFile = parts[configIdx + 1];
    expect(configFile).toMatch(/manifest-.+\.json$/);
  });

  it("writes a valid manifest JSON to the temp file", () => {
    const nonoPath = "/usr/bin/nono";
    const policy = makePolicy({
      network: { mode: "always", allow: ["example.com"] },
    });
    const hook = createSpawnHook(() => policy, makeCtx(), nonoPath);
    const output = hook({ command: "curl example.com" });

    const parts = output.command.split(" ");
    const configIdx = parts.indexOf("--config");
    const configFile = parts[configIdx + 1];

    const contents = JSON.parse(fs.readFileSync(configFile, "utf8"));
    expect(contents.network?.allow_domain).toContain("example.com");

    fs.unlinkSync(configFile);
  });

  it("uses bash -c to wrap the shell command string", () => {
    const nonoPath = "/usr/bin/nono";
    const hook = createSpawnHook(() => makePolicy(), makeCtx(), nonoPath);
    const output = hook({ command: "echo hello && echo world" });

    expect(output.command).toContain("bash");
    expect(output.command).toContain("-c");
    expect(output.command).toContain("echo hello && echo world");
  });

  it("rebuilds manifest fresh on each invocation (policy may have changed)", () => {
    const nonoPath = "/usr/bin/nono";
    let callCount = 0;
    const getPolicy = vi.fn(() => {
      callCount++;
      return makePolicy();
    });
    const hook = createSpawnHook(getPolicy, makeCtx(), nonoPath);

    hook({ command: "ls" });
    hook({ command: "pwd" });

    expect(getPolicy).toHaveBeenCalledTimes(2);
  });

  it("safely round-trips a command with internal spaces (echo 'hello world')", () => {
    const nonoPath = "/usr/bin/nono";
    const hook = createSpawnHook(() => makePolicy(), makeCtx(), nonoPath);
    const cmd = "echo 'hello world'";
    const output = hook({ command: cmd });

    // The shell string must be single-quoted so a downstream shell won't split
    // on the space. Single-quoting turns `echo 'hello world'` into
    // `'echo '\''hello world'\'''`, which when evaluated by a shell produces the
    // original string. We verify the key words survive the quoting.
    expect(output.command).toContain(nonoPath);
    expect(output.command).toContain("bash");
    expect(output.command).toContain("-c");
    expect(output.command).toContain("echo");
    expect(output.command).toContain("hello world");
  });

  it("safely round-trips a command containing $HOME", () => {
    const nonoPath = "/usr/bin/nono";
    const hook = createSpawnHook(() => makePolicy(), makeCtx(), nonoPath);
    const cmd = "echo $HOME";
    const output = hook({ command: cmd });

    expect(output.command).toContain(cmd);
  });

  it("emits an exec audit entry when nonoPath is provided", () => {
    const nonoPath = "/usr/bin/nono";
    const emitAudit = vi.fn();
    const hook = createSpawnHook(() => makePolicy(), makeCtx(), nonoPath, emitAudit);
    hook({ command: "ls" });

    expect(emitAudit).toHaveBeenCalledOnce();
    const [entry] = emitAudit.mock.calls[0] as [Omit<AuditEntry, "ts">];
    expect(entry.kind).toBe("exec");
    expect(entry.decision).toBe("allowed");
  });

  it("emits a degraded exec audit entry when nonoPath is null", () => {
    const emitAudit = vi.fn();
    const hook = createSpawnHook(() => makePolicy(), makeCtx(), null, emitAudit);
    hook({ command: "ls" });

    expect(emitAudit).toHaveBeenCalledOnce();
    const [entry] = emitAudit.mock.calls[0] as [Omit<AuditEntry, "ts">];
    expect(entry.kind).toBe("exec");
    expect(entry.decision).toBe("allowed");
    expect(entry.rule).toContain("degraded");
  });
});

describe("createUserBashHandler", () => {
  it("returns operation with original command when nonoPath is null", () => {
    const handler = createUserBashHandler(() => makePolicy(), makeCtx(), null);
    const result = handler({ command: "ls -la", cwd: "/tmp" });

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].command).toBe("ls -la");
    expect(result.operations[0].cwd).toBe("/tmp");
  });

  it("returns operation with nono-prefixed command when nonoPath is provided", () => {
    const nonoPath = "/usr/bin/nono";
    const handler = createUserBashHandler(() => makePolicy(), makeCtx(), nonoPath);
    const result = handler({ command: "cat /etc/hosts" });

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].command).toContain(nonoPath);
    expect(result.operations[0].command).toContain("--config");
    expect(result.operations[0].command).toContain("cat /etc/hosts");
  });

  it("preserves cwd and env in operations", () => {
    const nonoPath = "/usr/bin/nono";
    const env = { NODE_ENV: "test" };
    const handler = createUserBashHandler(() => makePolicy(), makeCtx(), nonoPath);
    const result = handler({ command: "node -v", cwd: "/project", env });

    expect(result.operations[0].cwd).toBe("/project");
    expect(result.operations[0].env).toEqual(env);
  });

  it("emits an exec audit entry when nonoPath is provided", () => {
    const nonoPath = "/usr/bin/nono";
    const emitAudit = vi.fn();
    const handler = createUserBashHandler(() => makePolicy(), makeCtx(), nonoPath, emitAudit);
    handler({ command: "curl example.com" });

    expect(emitAudit).toHaveBeenCalledOnce();
    const [entry] = emitAudit.mock.calls[0] as [Omit<AuditEntry, "ts">];
    expect(entry.kind).toBe("exec");
    expect(entry.decision).toBe("allowed");
  });

  it("emits a degraded exec audit entry when nonoPath is null", () => {
    const emitAudit = vi.fn();
    const handler = createUserBashHandler(() => makePolicy(), makeCtx(), null, emitAudit);
    handler({ command: "ls" });

    expect(emitAudit).toHaveBeenCalledOnce();
    const [entry] = emitAudit.mock.calls[0] as [Omit<AuditEntry, "ts">];
    expect(entry.kind).toBe("exec");
    expect(entry.rule).toContain("degraded");
  });
});

describe("wrapPiExec — re-wrap detection", () => {
  it("marks the wrapped function with piSandboxWrappedSymbol", () => {
    const pi = makePi();
    wrapPiExec(pi, () => makePolicy(), makeCtx(), "/usr/bin/nono");

    expect((pi.exec as { [piSandboxWrappedSymbol]?: true })[piSandboxWrappedSymbol]).toBe(true);
  });

  it("does not re-wrap if pi.exec already carries the symbol marker", () => {
    const originalExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }) as {
      (...args: unknown[]): Promise<ExecResult>;
      [piSandboxWrappedSymbol]?: true;
    };
    originalExec[piSandboxWrappedSymbol] = true;

    const pi = makePi({ exec: originalExec });
    wrapPiExec(pi, () => makePolicy(), makeCtx(), "/usr/bin/nono");

    expect(pi.exec).toBe(originalExec);
  });
});

describe("wrapPiExec — no sandbox opt-out", () => {
  it("sandbox opt-out (sandbox:false) is not supported; all exec calls go through nono", async () => {
    const originalExec = vi.fn().mockResolvedValue({ stdout: "result", stderr: "", code: 0, killed: false });
    const pi = makePi({ exec: originalExec });
    wrapPiExec(pi, () => makePolicy(), makeCtx(), "/usr/bin/nono");

    // Calling exec without sandbox:false — should go through nono (nonexistent path rejects)
    await expect(pi.exec!("ls", ["/etc"])).rejects.toThrow();
    expect(originalExec).not.toHaveBeenCalled();
  });
});

describe("wrapPiExec — fallback mode (nonoPath null)", () => {
  it("calls original exec when nono is not available", async () => {
    const originalExec = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", code: 0, killed: false });
    const pi = makePi({ exec: originalExec });
    wrapPiExec(pi, () => makePolicy(), makeCtx(), null);

    const result = await pi.exec!("ls", ["/etc"]);

    expect(originalExec).toHaveBeenCalledOnce();
    expect(result.stdout).toBe("ok");
  });

  it("emits a degraded exec audit entry in fallback mode", async () => {
    const pi = makePi();
    const emitAudit = vi.fn();
    wrapPiExec(pi, () => makePolicy(), makeCtx(), null, emitAudit);

    await pi.exec!("ls", ["/etc"]);

    expect(emitAudit).toHaveBeenCalledOnce();
    const [entry] = emitAudit.mock.calls[0] as [Omit<AuditEntry, "ts">];
    expect(entry.kind).toBe("exec");
    expect(entry.decision).toBe("allowed");
    expect(entry.rule).toContain("degraded");
  });
});

describe("wrapPiExec — return shape", () => {
  it("rejects when nono binary fails to spawn (ENOENT)", async () => {
    // runUnderNono rejects on spawn errors so the caller sees a proper Error,
    // not a silent { code: null } resolve. This covers the signature compatibility
    // requirement for spawn-error handling.
    const pi = makePi();
    wrapPiExec(pi, () => makePolicy(), makeCtx(), "/nonexistent/path/to/nono");

    await expect(pi.exec!("ls", [])).rejects.toThrow();
  });
});

describe("initSubprocessSandbox — missing binary (fallback mode)", () => {
  beforeEach(() => {
    vi.mocked(binaryMod.getNonoPath).mockReturnValue(null);
  });

  afterEach(() => {
    vi.mocked(binaryMod.getNonoPath).mockReset();
  });

  it("extension boots successfully even when nono is missing", () => {
    const pi = makePi();
    const ctx = makeCtx();

    expect(() => initSubprocessSandbox(pi, () => makePolicy(), ctx)).not.toThrow();
  });

  it("returns nonoPath as null in fallback mode", () => {
    const pi = makePi();
    const ctx = makeCtx();
    const result = initSubprocessSandbox(pi, () => makePolicy(), ctx);

    expect(result.nonoPath).toBeNull();
  });

  it("returns working spawnHook and userBashHandler in fallback mode", () => {
    const pi = makePi();
    const ctx = makeCtx();
    const { spawnHook, userBashHandler } = initSubprocessSandbox(pi, () => makePolicy(), ctx);

    const hookResult = spawnHook({ command: "ls" });
    expect(hookResult.command).toBe("ls");

    const bashResult = userBashHandler({ command: "ls" });
    expect(bashResult.operations[0].command).toBe("ls");
  });
});

describe("initSubprocessSandbox — with nono binary present", () => {
  beforeEach(() => {
    vi.mocked(binaryMod.getNonoPath).mockReturnValue("/usr/bin/nono");
  });

  afterEach(() => {
    vi.mocked(binaryMod.getNonoPath).mockReset();
  });

  it("wraps pi.exec with sandbox marker", () => {
    const pi = makePi();
    const ctx = makeCtx();
    initSubprocessSandbox(pi, () => makePolicy(), ctx);

    expect((pi.exec as { [piSandboxWrappedSymbol]?: true })[piSandboxWrappedSymbol]).toBe(true);
  });

  it("returns nonoPath", () => {
    const pi = makePi();
    const ctx = makeCtx();
    const result = initSubprocessSandbox(pi, () => makePolicy(), ctx);

    expect(result.nonoPath).toBe("/usr/bin/nono");
  });

  it("passes emitAudit to spawnHook so sandbox:audit events are emitted via pi.events.emit", () => {
    const pi = makePi();
    const ctx = makeCtx();
    const { spawnHook } = initSubprocessSandbox(pi, () => makePolicy(), ctx);

    spawnHook({ command: "ls" });

    const emitMock = pi.events.emit as ReturnType<typeof vi.fn>;
    const auditCalls = emitMock.mock.calls.filter(
      (args: unknown[]) => args[0] === "sandbox:audit"
    );
    expect(auditCalls).toHaveLength(1);
    const [, payload] = auditCalls[0] as [string, AuditEntry];
    expect(payload.kind).toBe("exec");
    expect(payload.decision).toBe("allowed");
  });

  it("passes emitAudit to userBashHandler so sandbox:audit events are emitted via pi.events.emit", () => {
    const pi = makePi();
    const ctx = makeCtx();
    const { userBashHandler } = initSubprocessSandbox(pi, () => makePolicy(), ctx);

    userBashHandler({ command: "echo test" });

    const emitMock = pi.events.emit as ReturnType<typeof vi.fn>;
    const auditCalls = emitMock.mock.calls.filter(
      (args: unknown[]) => args[0] === "sandbox:audit"
    );
    expect(auditCalls).toHaveLength(1);
    const [, payload] = auditCalls[0] as [string, AuditEntry];
    expect(payload.kind).toBe("exec");
    expect(payload.decision).toBe("allowed");
  });

  // Guard test: pi.registerTool and pi.on("user_bash", ...) are intentionally deferred
  // until @earendil-works/pi-coding-agent is installable. When that package becomes
  // available, remove this test and wire them in initSubprocessSandbox directly.
  it("does not call pi.registerTool or pi.on (deferred — @earendil-works/pi-coding-agent not yet installable)", () => {
    const pi = makePi({ registerTool: vi.fn(), on: vi.fn() });
    const ctx = makeCtx();
    initSubprocessSandbox(pi, () => makePolicy(), ctx);

    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(pi.on).not.toHaveBeenCalled();
  });
});

describe("wrapPiExec — audit event for sandboxed exec", () => {
  it("emits exec audit entry before spawn attempt when nono is available", async () => {
    const pi = makePi();
    const auditEntries: Omit<AuditEntry, "ts">[] = [];
    const emitAudit = vi.fn((entry: Omit<AuditEntry, "ts">) => { auditEntries.push(entry); });

    // Use a clearly nonexistent path so runUnderNono rejects quickly, but the
    // audit entry should have been recorded before the spawn attempt.
    wrapPiExec(pi, () => makePolicy(), makeCtx(), "/nonexistent/nono", emitAudit);

    await pi.exec!("git", ["status"]).catch(() => {});

    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].kind).toBe("exec");
    expect(auditEntries[0].tool).toBe("git");
    expect(auditEntries[0].decision).toBe("allowed");
  });
});

describe("per-pid manifest dir lifecycle", () => {
  it("ensurePidDir creates the dir and ensurePidExitHandler cleans it up when the listener fires", () => {
    const testDir = path.join(os.tmpdir(), `pi-sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}

    ensurePidDir(testDir);
    expect(fs.existsSync(testDir)).toBe(true);
    expect(fs.statSync(testDir).mode & 0o777).toBe(0o700);

    fs.writeFileSync(path.join(testDir, "manifest-test.json"), "{}", { mode: 0o600 });
    expect(fs.existsSync(path.join(testDir, "manifest-test.json"))).toBe(true);

    // Register the exit handler pointing at testDir, then fire the process 'exit'
    // listeners inline to simulate process exit without actually exiting.
    ensurePidExitHandler(testDir);
    const listeners = process.listeners("exit");
    // The last registered listener is the one we just added.
    const ourListener = listeners[listeners.length - 1] as NodeJS.ExitListener;
    ourListener(0);
    process.removeListener("exit", ourListener);

    expect(fs.existsSync(testDir)).toBe(false);
  });
});
