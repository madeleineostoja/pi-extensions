import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import type {
  BashOperations,
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  UserBashEvent,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import type { Policy } from "../policy/defaults.js";
import type { ManifestContext } from "./caps.js";
import { createCaps } from "./caps.js";
import type { BinaryStatus } from "../runtime/binary.js";
import { getNonoPath, getBinaryStatus } from "../runtime/binary.js";
import { createAuditPipeline } from "../audit/audit.js";
import type { AuditEntry } from "../audit/schema.js";
import type { SessionState } from "../slash/commands.js";
import { applySessionOverrides } from "../policy/effective.js";

export type { ExecOptions, ExecResult };

// Symbol used to detect re-wrapping: if pi.exec already carries this marker, skip.
export const piSandboxWrappedSymbol = Symbol("piSandboxWrapped");

export type PiExecFnWrapped = ExtensionAPI["exec"] & {
  [piSandboxWrappedSymbol]?: true;
};

export type UserBashHandler = (
  event: UserBashEvent,
) => UserBashEventResult | undefined;

export type SandboxWrapperOptions = {
  getPolicy: () => Policy;
  getSession?: () => SessionState;
  ctx: ManifestContext;
  nonoPath?: string | null;
};

function buildNonoArgv(
  nonoPath: string,
  manifestPath: string,
  originalCommand: string,
  originalArgs: string[],
): { file: string; args: string[] } {
  return {
    file: nonoPath,
    args: [
      "run",
      "--config",
      manifestPath,
      "--",
      originalCommand,
      ...originalArgs,
    ],
  };
}

function buildNonoShellArgv(
  nonoPath: string,
  manifestPath: string,
  shellString: string,
): { file: string; args: string[] } {
  return {
    file: nonoPath,
    args: ["run", "--config", manifestPath, "--", "bash", "-c", shellString],
  };
}

/**
 * Runs a command under nono. Rejects if the child process fails to spawn
 * (ENOENT, permission denied, etc.). Resolves with `{ code: null }` if the
 * process was killed or terminated by a signal; code is the numeric exit code
 * otherwise. The `killed` field is true only when our own timeout triggered
 * the kill — it does NOT reflect an external signal.
 */
function runUnderNono(
  nonoPath: string,
  manifestPath: string,
  command: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const { file, args: nonoArgs } = buildNonoArgv(
    nonoPath,
    manifestPath,
    command,
    args,
  );

  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(file, nonoArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let killed = false;

    if (opts.timeout !== undefined) {
      timeoutHandle = setTimeout(() => {
        killed = true;
        child.kill();
      }, opts.timeout);
    }

    child.once("close", (code) => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      try {
        fs.unlinkSync(manifestPath);
      } catch {
        /* best-effort */
      }
      resolve({ stdout, stderr, code: code ?? -1, killed });
    });

    child.once("error", (err) => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      try {
        fs.unlinkSync(manifestPath);
      } catch {
        /* best-effort */
      }
      reject(err);
    });
  });
}

function removeManifest(manifestPath: string): void {
  try {
    fs.unlinkSync(manifestPath);
  } catch {
    // best-effort
  }
}

function runUserBashUnderNono(
  nonoPath: string,
  manifestPath: string,
  command: string,
  cwd: string,
  opts: Parameters<BashOperations["exec"]>[2],
): Promise<{ exitCode: number | null }> {
  const { file, args } = buildNonoShellArgv(nonoPath, manifestPath, command);

  return new Promise((resolve, reject) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let timedOut = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      removeManifest(manifestPath);
      fn();
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        signal: opts.signal,
      });
    } catch (err) {
      settle(() => reject(err));
      return;
    }

    child.stdout?.on("data", opts.onData);
    child.stderr?.on("data", opts.onData);

    if (opts.timeout !== undefined && opts.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, opts.timeout * 1000);
    }

    child.once("close", (code) => {
      settle(() => {
        if (timedOut) {
          reject(new Error(`timeout:${opts.timeout}`));
          return;
        }
        resolve({ exitCode: code });
      });
    });

    child.once("error", (err) => {
      settle(() => reject(err));
    });
  });
}

// ---------------------------------------------------------------------------
// Per-process manifest directory — shared across all instances in the same process
// ---------------------------------------------------------------------------

const pidDir = path.join(os.tmpdir(), `pi-sandbox-${process.pid}`);
// Process-scoped resources: there is exactly one pid dir and one exit handler
// per Node process regardless of how many sandboxExtension instances exist.
let pidDirReady = false;
let pidExitHandlerRegistered = false;

export function ensurePidDir(targetDir?: string): void {
  const dir = targetDir ?? pidDir;
  if (targetDir === undefined) {
    if (pidDirReady) return;
    pidDirReady = true;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function ensurePidExitHandler(targetDir?: string): void {
  const dir = targetDir ?? pidDir;
  if (targetDir === undefined) {
    if (pidExitHandlerRegistered) return;
    pidExitHandlerRegistered = true;
  }
  process.on("exit", () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
}

function writePidManifest(manifest: object): string {
  ensurePidDir();
  ensurePidExitHandler();
  const tmpPath = path.join(pidDir, `manifest-${randomUUID()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(manifest), {
    encoding: "utf8",
    mode: 0o600,
  });
  return tmpPath;
}

// ---------------------------------------------------------------------------
// Public factory helpers
// ---------------------------------------------------------------------------

export function wrapPiExec(
  pi: ExtensionAPI,
  getPolicy: () => Policy,
  ctx: ManifestContext,
  nonoPath: string | null,
  emitAudit?: (entry: Omit<AuditEntry, "ts">) => void,
  getSession?: () => SessionState,
  caps?: ReturnType<typeof createCaps>,
): () => void {
  if ((pi.exec as PiExecFnWrapped)[piSandboxWrappedSymbol]) {
    // Already wrapped by a prior session — caller is responsible for not
    // double-wrapping. Return a no-op unwrap so callers can compose safely.
    return () => {};
  }

  const capsInstance = caps ?? createCaps();
  const originalExec = pi.exec.bind(pi);

  const wrappedExec: PiExecFnWrapped = async function sandboxedExec(
    command: string,
    args: string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    const effectivePol = getSession
      ? applySessionOverrides(getPolicy(), getSession())
      : getPolicy();

    if (effectivePol.enabled === false) {
      emitAudit?.({
        kind: "exec",
        decision: "allowed",
        tool: command,
        rule: "session:sandbox-off",
      });
      return originalExec(command, args, opts);
    }

    if (nonoPath === null) {
      if (effectivePol.degraded?.allowExec === true) {
        emitAudit?.({
          kind: "exec",
          decision: "allowed",
          tool: command,
          rule: "degraded:no-nono",
        });
        return originalExec(command, args, opts);
      }
      emitAudit?.({
        kind: "exec",
        decision: "blocked",
        tool: command,
        rule: "degraded:no-nono",
      });
      return Promise.reject(
        new Error(
          "sandbox: exec blocked — kernel sandbox unavailable and degraded.allowExec is false",
        ),
      );
    }

    const manifest = capsInstance.buildManifest(effectivePol, ctx);
    const tmpPath = writePidManifest(manifest);

    emitAudit?.({
      kind: "exec",
      decision: "allowed",
      tool: command,
    });

    return runUnderNono(nonoPath, tmpPath, command, args, opts);
  };

  wrappedExec[piSandboxWrappedSymbol] = true;
  (pi as { exec: PiExecFnWrapped }).exec = wrappedExec;

  return () => {
    if ((pi.exec as PiExecFnWrapped) === wrappedExec) {
      (pi as { exec: ExtensionAPI["exec"] }).exec = originalExec;
    }
  };
}

export function createUserBashHandler(
  getPolicy: () => Policy,
  ctx: ManifestContext,
  nonoPath: string | null,
  emitAudit?: (entry: Omit<AuditEntry, "ts">) => void,
  getSession?: () => SessionState,
  caps?: ReturnType<typeof createCaps>,
): UserBashHandler {
  const capsInstance = caps ?? createCaps();

  return function handleUserBash(
    _event: UserBashEvent,
  ): UserBashEventResult | undefined {
    const policy = getSession
      ? applySessionOverrides(getPolicy(), getSession())
      : getPolicy();

    if (nonoPath === null) {
      if (policy.degraded?.allowExec === true) {
        emitAudit?.({
          kind: "exec",
          decision: "allowed",
          tool: "bash",
          rule: "degraded:no-nono",
        });
        return undefined;
      }
      emitAudit?.({
        kind: "exec",
        decision: "blocked",
        tool: "bash",
        rule: "degraded:no-nono",
      });
      return {
        result: {
          output:
            "sandbox: bash blocked — kernel sandbox unavailable and degraded.allowExec is false",
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }

    if (policy.enabled === false) {
      emitAudit?.({
        kind: "exec",
        decision: "allowed",
        tool: "bash",
        rule: "session:sandbox-off",
      });
      return undefined;
    }

    return {
      operations: {
        exec(command, cwd, options) {
          const manifest = capsInstance.buildManifest(policy, ctx);
          const tmpPath = writePidManifest(manifest);

          emitAudit?.({
            kind: "exec",
            decision: "allowed",
            tool: "bash",
          });

          return runUserBashUnderNono(nonoPath, tmpPath, command, cwd, options);
        },
      },
    };
  };
}

// ---------------------------------------------------------------------------
// SubprocessSandbox factory
// ---------------------------------------------------------------------------

export type SubprocessSandboxResult = {
  userBashHandler: UserBashHandler;
  nonoPath: string | null;
  /** Restore pi.exec to its pre-wrap value. Safe to call multiple times. */
  unwrap: () => void;
};

export function createSubprocessSandbox(
  pi: ExtensionAPI,
  getPolicy: () => Policy,
  ctx: ManifestContext,
  getSession?: () => SessionState,
  nonoPath?: string | null,
  emitAudit?: (entry: Omit<AuditEntry, "ts">) => void,
): SubprocessSandboxResult {
  if (nonoPath === undefined) {
    nonoPath = getNonoPath();
  }

  let auditFn = emitAudit;
  if (auditFn === undefined) {
    const piEvents = {
      emit: (event: string, payload: unknown) => pi.events.emit(event, payload),
    };
    const { recordAudit } = createAuditPipeline();
    auditFn = (entry: Omit<AuditEntry, "ts">): void => {
      const policy = getPolicy();
      recordAudit(entry, {
        logEnabled: policy.audit.log,
        logFile: policy.audit.logFile,
        events: piEvents,
      });
    };
  }

  const caps = createCaps();

  const unwrap = wrapPiExec(
    pi,
    getPolicy,
    ctx,
    nonoPath,
    auditFn,
    getSession,
    caps,
  );

  const userBashHandler = createUserBashHandler(
    getPolicy,
    ctx,
    nonoPath,
    auditFn,
    getSession,
    caps,
  );

  return { userBashHandler, nonoPath, unwrap };
}

export function initSubprocessSandbox(
  pi: ExtensionAPI,
  getPolicy: () => Policy,
  ctx: ManifestContext,
  getSession?: () => SessionState,
  nonoPath?: string | null,
  emitAudit?: (entry: Omit<AuditEntry, "ts">) => void,
): SubprocessSandboxResult & { binaryStatus: BinaryStatus } {
  const binaryStatus = getBinaryStatus();

  if (nonoPath === undefined) {
    nonoPath = getNonoPath();
  }

  const result = createSubprocessSandbox(
    pi,
    getPolicy,
    ctx,
    getSession,
    nonoPath,
    emitAudit,
  );

  return { ...result, binaryStatus };
}
