import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export interface SpawnHookInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface SpawnHookOutput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export type PiExecFnWrapped = ExtensionAPI["exec"] & { [piSandboxWrappedSymbol]?: true };

export interface UserBashOperation {
  type: "bash";
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface UserBashResult {
  operations: UserBashOperation[];
}

export interface SandboxWrapperOptions {
  getPolicy: () => Policy;
  getSession?: () => SessionState;
  ctx: ManifestContext;
  nonoPath?: string | null;
}

function buildNonoArgv(
  nonoPath: string,
  manifestPath: string,
  originalCommand: string,
  originalArgs: string[]
): { file: string; args: string[] } {
  return {
    file: nonoPath,
    args: ["run", "--config", manifestPath, "--", originalCommand, ...originalArgs],
  };
}

function buildNonoShellArgv(
  nonoPath: string,
  manifestPath: string,
  shellString: string
): { file: string; args: string[] } {
  return {
    file: nonoPath,
    args: ["run", "--config", manifestPath, "--", "bash", "-c", shellString],
  };
}

/**
 * Serializes a nono argv triple into a shell-safe string by quoting the
 * `bash -c <shellString>` component. The shell string is passed as a single
 * argument to `bash -c`; it must not be split or re-joined.
 *
 * We use single-quoting with internal single-quote escaping so that any
 * content in `shellString` (spaces, `$`, backticks, etc.) is preserved verbatim.
 */
function serializeNonoShellCommand(nonoPath: string, nonoArgs: string[]): string {
  const shellStringIdx = nonoArgs.length - 1;
  const parts: string[] = [nonoPath];
  for (let i = 0; i < nonoArgs.length; i++) {
    if (i === shellStringIdx) {
      const escaped = nonoArgs[i].replace(/'/g, "'\\''");
      parts.push(`'${escaped}'`);
    } else {
      parts.push(nonoArgs[i]);
    }
  }
  return parts.join(" ");
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
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const { file, args: nonoArgs } = buildNonoArgv(nonoPath, manifestPath, command, args);

  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(file, nonoArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let killed = false;

    if (opts.timeout !== undefined) {
      timeoutHandle = setTimeout(() => {
        killed = true;
        child.kill();
      }, opts.timeout);
    }

    child.once("exit", (code) => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      try { fs.unlinkSync(manifestPath); } catch { /* best-effort */ }
      resolve({ stdout, stderr, code: code ?? -1, killed });
    });

    child.once("error", (err) => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      try { fs.unlinkSync(manifestPath); } catch { /* best-effort */ }
      reject(err);
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
  fs.writeFileSync(tmpPath, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
  return tmpPath;
}

// ---------------------------------------------------------------------------
// Public factory helpers
// ---------------------------------------------------------------------------

export function createSpawnHook(
  getPolicy: () => Policy,
  ctx: ManifestContext,
  nonoPath: string | null,
  emitAudit?: (entry: Omit<AuditEntry, "ts">) => void,
  getSession?: () => SessionState,
  caps?: ReturnType<typeof createCaps>
): (input: SpawnHookInput) => SpawnHookOutput {
  const capsInstance = caps ?? createCaps();

  return function spawnHook(input: SpawnHookInput): SpawnHookOutput {
    if (nonoPath === null) {
      emitAudit?.({
        kind: "exec",
        decision: "allowed",
        tool: "bash",
        rule: "degraded:no-nono",
      });
      return input;
    }

    const policy = getSession
      ? applySessionOverrides(getPolicy(), getSession())
      : getPolicy();

    if (policy.enabled === false) {
      emitAudit?.({
        kind: "exec",
        decision: "allowed",
        tool: "bash",
        rule: "session:sandbox-off",
      });
      return input;
    }

    const manifest = capsInstance.buildManifest(policy, ctx);
    const tmpPath = writePidManifest(manifest);

    const { file, args } = buildNonoShellArgv(nonoPath, tmpPath, input.command);
    const newCommand = serializeNonoShellCommand(file, args);

    emitAudit?.({
      kind: "exec",
      decision: "allowed",
      tool: "bash",
    });

    return {
      command: newCommand,
      cwd: input.cwd,
      env: input.env,
    };
  };
}

export function createBashToolConfig(
  cwd: string,
  spawnHook: (input: SpawnHookInput) => SpawnHookOutput
): { cwd: string; spawnHook: (input: SpawnHookInput) => SpawnHookOutput } {
  return { cwd, spawnHook };
}

export function wrapPiExec(
  pi: ExtensionAPI,
  getPolicy: () => Policy,
  ctx: ManifestContext,
  nonoPath: string | null,
  emitAudit?: (entry: Omit<AuditEntry, "ts">) => void,
  getSession?: () => SessionState,
  caps?: ReturnType<typeof createCaps>
): void {
  if ((pi.exec as PiExecFnWrapped)[piSandboxWrappedSymbol]) {
    return;
  }

  const capsInstance = caps ?? createCaps();
  const originalExec = pi.exec.bind(pi);

  const wrappedExec: PiExecFnWrapped = async function sandboxedExec(
    command: string,
    args: string[],
    opts?: ExecOptions
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
      emitAudit?.({
        kind: "exec",
        decision: "allowed",
        tool: command,
        rule: "degraded:no-nono",
      });
      return originalExec(command, args, opts);
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
}

export function createUserBashHandler(
  getPolicy: () => Policy,
  ctx: ManifestContext,
  nonoPath: string | null,
  emitAudit?: (entry: Omit<AuditEntry, "ts">) => void,
  getSession?: () => SessionState,
  caps?: ReturnType<typeof createCaps>
): (event: { command: string; cwd?: string; env?: Record<string, string> }) => UserBashResult {
  const capsInstance = caps ?? createCaps();

  return function handleUserBash(event): UserBashResult {
    if (nonoPath === null) {
      emitAudit?.({
        kind: "exec",
        decision: "allowed",
        tool: "bash",
        rule: "degraded:no-nono",
      });
      return {
        operations: [
          {
            type: "bash",
            command: event.command,
            cwd: event.cwd,
            env: event.env,
          },
        ],
      };
    }

    const policy = getSession
      ? applySessionOverrides(getPolicy(), getSession())
      : getPolicy();

    if (policy.enabled === false) {
      emitAudit?.({
        kind: "exec",
        decision: "allowed",
        tool: "bash",
        rule: "session:sandbox-off",
      });
      return {
        operations: [
          {
            type: "bash",
            command: event.command,
            cwd: event.cwd,
            env: event.env,
          },
        ],
      };
    }

    const manifest = capsInstance.buildManifest(policy, ctx);
    const tmpPath = writePidManifest(manifest);

    const { file, args } = buildNonoShellArgv(nonoPath, tmpPath, event.command);
    const rewrittenCommand = serializeNonoShellCommand(file, args);

    emitAudit?.({
      kind: "exec",
      decision: "allowed",
      tool: "bash",
    });

    return {
      operations: [
        {
          type: "bash",
          command: rewrittenCommand,
          cwd: event.cwd,
          env: event.env,
        },
      ],
    };
  };
}

// ---------------------------------------------------------------------------
// SubprocessSandbox factory
// ---------------------------------------------------------------------------

export interface SubprocessSandboxResult {
  spawnHook: (input: SpawnHookInput) => SpawnHookOutput;
  userBashHandler: (event: { command: string; cwd?: string; env?: Record<string, string> }) => UserBashResult;
  nonoPath: string | null;
}

export function createSubprocessSandbox(
  pi: ExtensionAPI,
  getPolicy: () => Policy,
  ctx: ManifestContext,
  getSession?: () => SessionState,
  nonoPath?: string | null,
  emitAudit?: (entry: Omit<AuditEntry, "ts">) => void
): SubprocessSandboxResult {
  if (nonoPath === undefined) {
    nonoPath = getNonoPath();
  }

  let auditFn = emitAudit;
  if (auditFn === undefined) {
    const piEvents = { emit: (event: string, payload: unknown) => pi.events.emit(event, payload) };
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

  wrapPiExec(pi, getPolicy, ctx, nonoPath, auditFn, getSession, caps);

  const spawnHook = createSpawnHook(getPolicy, ctx, nonoPath, auditFn, getSession, caps);
  const userBashHandler = createUserBashHandler(getPolicy, ctx, nonoPath, auditFn, getSession, caps);

  // TODO: Wire pi.registerTool and pi.on("user_bash", ...) once the bash tool
  // integration is implemented. Until then, spawnHook and userBashHandler are
  // returned for the caller to wire.

  return { spawnHook, userBashHandler, nonoPath };
}

export function initSubprocessSandbox(
  pi: ExtensionAPI,
  getPolicy: () => Policy,
  ctx: ManifestContext,
  getSession?: () => SessionState,
  nonoPath?: string | null,
  emitAudit?: (entry: Omit<AuditEntry, "ts">) => void
): SubprocessSandboxResult & { binaryStatus: BinaryStatus } {
  const binaryStatus = getBinaryStatus();

  if (nonoPath === undefined) {
    nonoPath = getNonoPath();
  }

  const result = createSubprocessSandbox(pi, getPolicy, ctx, getSession, nonoPath, emitAudit);

  return { ...result, binaryStatus };
}
