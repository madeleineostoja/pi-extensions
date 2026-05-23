import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../runtime/binary.js", () => ({
  getNonoPath: vi.fn(),
  getBinaryStatus: vi
    .fn()
    .mockReturnValue({ kind: "install-failed", reason: "marker-missing" }),
}));

import * as binaryMod from "../runtime/binary.js";
import {
  createUserBashHandler,
  wrapPiExec,
  initSubprocessSandbox,
  piSandboxWrappedSymbol,
  ensurePidDir,
  ensurePidExitHandler,
} from "./subprocess.js";
import type { ExecResult } from "./subprocess.js";
import type {
  ExtensionAPI,
  UserBashEvent,
} from "@earendil-works/pi-coding-agent";
import type { AuditEntry } from "../audit/schema.js";
import type { Policy } from "../policy/defaults.js";
import type { ManifestContext } from "./caps.js";

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
    exec: vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false }),
    events: { emit: vi.fn() },
    ...overrides,
  } as unknown as ExtensionAPI;
}

function makeUserBashEvent(
  command: string,
  cwd = process.cwd(),
): UserBashEvent {
  return {
    type: "user_bash",
    command,
    cwd,
    excludeFromContext: false,
  };
}

function createFakeNono(tmpDir: string): {
  nonoPath: string;
  argsPath: string;
  manifestCopyPath: string;
} {
  const nonoPath = path.join(tmpDir, "nono");
  const argsPath = path.join(tmpDir, "nono-args.txt");
  const manifestCopyPath = path.join(tmpDir, "manifest-copy.json");
  fs.writeFileSync(
    nonoPath,
    `#!/usr/bin/env bash
printf '%s\\0' "$@" > ${JSON.stringify(argsPath)}
cp "$3" ${JSON.stringify(manifestCopyPath)}
printf 'fake nono output'
`,
    { mode: 0o755 },
  );
  return { nonoPath, argsPath, manifestCopyPath };
}

function readFakeNonoArgs(argsPath: string): string[] {
  const parts = fs.readFileSync(argsPath, "utf8").split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

describe("createUserBashHandler", () => {
  it("returns undefined and lets pi run normally when nonoPath is null", () => {
    const handler = createUserBashHandler(() => makePolicy(), makeCtx(), null);
    const result = handler(makeUserBashEvent("ls -la", "/tmp"));

    expect(result).toBeUndefined();
  });

  it("returns operations when nonoPath is provided", () => {
    const nonoPath = "/usr/bin/nono";
    const handler = createUserBashHandler(
      () => makePolicy(),
      makeCtx(),
      nonoPath,
    );
    const result = handler(makeUserBashEvent("cat /etc/hosts"));

    expect(result?.operations?.exec).toEqual(expect.any(Function));
  });

  it("executes the command through nono with bash -c", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-user-bash-"));
    try {
      const { nonoPath, argsPath } = createFakeNono(tmpDir);
      const handler = createUserBashHandler(
        () => makePolicy(),
        makeCtx({ cwd: tmpDir }),
        nonoPath,
      );
      const result = handler(makeUserBashEvent("ignored by backend", tmpDir));
      const chunks: Buffer[] = [];

      const execResult = await result?.operations?.exec(
        "cat /etc/hosts",
        tmpDir,
        { onData: (data) => chunks.push(data) },
      );

      expect(execResult).toEqual({ exitCode: 0 });
      expect(Buffer.concat(chunks).toString()).toBe("fake nono output");

      const args = readFakeNonoArgs(argsPath);
      expect(args[0]).toBe("run");
      expect(args[1]).toBe("--config");
      expect(args[2]).toMatch(/manifest-.+\.json$/);
      expect(args.slice(3)).toEqual(["--", "bash", "-c", "cat /etc/hosts"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes the operations exec command argument instead of the original event command", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-user-bash-"));
    try {
      const { nonoPath, argsPath } = createFakeNono(tmpDir);
      const handler = createUserBashHandler(
        () => makePolicy(),
        makeCtx({ cwd: tmpDir }),
        nonoPath,
      );
      const result = handler(makeUserBashEvent("original", tmpDir));

      await result?.operations?.exec("prefixed\noriginal", tmpDir, {
        onData: vi.fn(),
      });

      const args = readFakeNonoArgs(argsPath);
      expect(args[6]).toBe("prefixed\noriginal");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes a manifest and removes the temp file after execution", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-user-bash-"));
    try {
      const { nonoPath, argsPath, manifestCopyPath } = createFakeNono(tmpDir);
      const handler = createUserBashHandler(
        () =>
          makePolicy({
            network: { mode: "always", allow: ["example.com"] },
          }),
        makeCtx({ cwd: tmpDir }),
        nonoPath,
      );
      const result = handler(makeUserBashEvent("curl example.com", tmpDir));

      await result?.operations?.exec("curl example.com", tmpDir, {
        onData: vi.fn(),
      });

      const args = readFakeNonoArgs(argsPath);
      const manifestPath = args[2];
      const manifest = JSON.parse(fs.readFileSync(manifestCopyPath, "utf8"));

      expect(manifest.network?.allow_domain).toContain("example.com");
      expect(fs.existsSync(manifestPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("emits an exec audit entry when sandboxed operations execute", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-user-bash-"));
    try {
      const { nonoPath } = createFakeNono(tmpDir);
      const emitAudit = vi.fn();
      const handler = createUserBashHandler(
        () => makePolicy(),
        makeCtx({ cwd: tmpDir }),
        nonoPath,
        emitAudit,
      );
      const result = handler(makeUserBashEvent("curl example.com", tmpDir));

      expect(emitAudit).not.toHaveBeenCalled();

      await result?.operations?.exec("curl example.com", tmpDir, {
        onData: vi.fn(),
      });

      expect(emitAudit).toHaveBeenCalledOnce();
      const [entry] = emitAudit.mock.calls[0] as [Omit<AuditEntry, "ts">];
      expect(entry.kind).toBe("exec");
      expect(entry.decision).toBe("allowed");
      expect(entry.tool).toBe("bash");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("emits a degraded exec audit entry when nonoPath is null", () => {
    const emitAudit = vi.fn();
    const handler = createUserBashHandler(
      () => makePolicy(),
      makeCtx(),
      null,
      emitAudit,
    );
    const result = handler(makeUserBashEvent("ls"));

    expect(result).toBeUndefined();
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

    expect(
      (pi.exec as { [piSandboxWrappedSymbol]?: true })[piSandboxWrappedSymbol],
    ).toBe(true);
  });

  it("does not re-wrap if pi.exec already carries the symbol marker", () => {
    const originalExec = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }) as {
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
    const originalExec = vi.fn().mockResolvedValue({
      stdout: "result",
      stderr: "",
      code: 0,
      killed: false,
    });
    const pi = makePi({ exec: originalExec });
    wrapPiExec(pi, () => makePolicy(), makeCtx(), "/usr/bin/nono");

    // Calling exec without sandbox:false — should go through nono (nonexistent path rejects)
    await expect(pi.exec!("ls", ["/etc"])).rejects.toThrow();
    expect(originalExec).not.toHaveBeenCalled();
  });
});

describe("wrapPiExec — fallback mode (nonoPath null)", () => {
  it("calls original exec when nono is not available", async () => {
    const originalExec = vi
      .fn()
      .mockResolvedValue({ stdout: "ok", stderr: "", code: 0, killed: false });
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

    expect(() =>
      initSubprocessSandbox(pi, () => makePolicy(), ctx),
    ).not.toThrow();
  });

  it("returns nonoPath as null in fallback mode", () => {
    const pi = makePi();
    const ctx = makeCtx();
    const result = initSubprocessSandbox(pi, () => makePolicy(), ctx);

    expect(result.nonoPath).toBeNull();
  });

  it("returns a userBashHandler that falls back to pi's default backend", () => {
    const pi = makePi();
    const ctx = makeCtx();
    const { userBashHandler } = initSubprocessSandbox(
      pi,
      () => makePolicy(),
      ctx,
    );

    const bashResult = userBashHandler(makeUserBashEvent("ls", "/"));
    expect(bashResult).toBeUndefined();
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

    expect(
      (pi.exec as { [piSandboxWrappedSymbol]?: true })[piSandboxWrappedSymbol],
    ).toBe(true);
  });

  it("returns nonoPath", () => {
    const pi = makePi();
    const ctx = makeCtx();
    const result = initSubprocessSandbox(pi, () => makePolicy(), ctx);

    expect(result.nonoPath).toBe("/usr/bin/nono");
  });

  it("passes emitAudit to userBashHandler so sandbox:audit events are emitted via pi.events.emit", async () => {
    const pi = makePi();
    const ctx = makeCtx();
    const { userBashHandler } = initSubprocessSandbox(
      pi,
      () => makePolicy(),
      ctx,
    );

    const result = userBashHandler(makeUserBashEvent("echo test", "/"));
    await result?.operations
      ?.exec("echo test", "/", { onData: vi.fn() })
      .catch(() => {});

    const emitMock = pi.events.emit as ReturnType<typeof vi.fn>;
    const auditCalls = emitMock.mock.calls.filter(
      (args: unknown[]) => args[0] === "sandbox:audit",
    );
    expect(auditCalls).toHaveLength(1);
    const [, payload] = auditCalls[0] as [string, AuditEntry];
    expect(payload.kind).toBe("exec");
    expect(payload.decision).toBe("allowed");
  });

  // Factory purity: event wiring belongs in index.ts, not in initSubprocessSandbox.
  it("does not call pi.registerTool or pi.on", () => {
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
    const emitAudit = vi.fn((entry: Omit<AuditEntry, "ts">) => {
      auditEntries.push(entry);
    });

    // Use a clearly nonexistent path so runUnderNono rejects quickly, but the
    // audit entry should have been recorded before the spawn attempt.
    wrapPiExec(
      pi,
      () => makePolicy(),
      makeCtx(),
      "/nonexistent/nono",
      emitAudit,
    );

    await pi.exec!("git", ["status"]).catch(() => {});

    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].kind).toBe("exec");
    expect(auditEntries[0].tool).toBe("git");
    expect(auditEntries[0].decision).toBe("allowed");
  });
});

describe("per-pid manifest dir lifecycle", () => {
  it("ensurePidDir creates the dir and ensurePidExitHandler cleans it up when the listener fires", () => {
    const testDir = path.join(
      os.tmpdir(),
      `pi-sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}

    ensurePidDir(testDir);
    expect(fs.existsSync(testDir)).toBe(true);
    expect(fs.statSync(testDir).mode & 0o777).toBe(0o700);

    fs.writeFileSync(path.join(testDir, "manifest-test.json"), "{}", {
      mode: 0o600,
    });
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
