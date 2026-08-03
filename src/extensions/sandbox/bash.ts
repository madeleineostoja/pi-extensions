import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter, join } from "node:path";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  getAgentDir,
  getShellConfig,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import {
  formatSandboxWriteDenial,
  type SandboxDenialObserver,
} from "./denial-observer.js";
import type { SandboxPolicy } from "./policy.js";
import { SANDBOX_EXECUTABLE, sandboxArguments } from "./seatbelt.js";
import type {
  SandboxExecutionLease,
  SandboxExecutionTerminal,
  SandboxManagedRequest,
} from "./bash-capability.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
const TERMINATION_WAIT_MS = 5_000;
const TERMINATION_POLL_MS = 10;
const OUTPUT_DRAIN_TIMEOUT_MS = 2_000;
const LAUNCH_MARKER = "__PIPKIN_SANDBOX_LAUNCHED__\n";
const LAUNCH_PREFIX = `printf '${LAUNCH_MARKER}'\n`;
const MAX_LAUNCH_DIAGNOSTIC_BYTES = 64 * 1024;

function denialMarker(correlation?: string): string {
  const suffix = correlation?.replaceAll(/[^a-zA-Z0-9]/g, "").slice(-24);
  return `PIPKIN_${suffix ? `${suffix}_` : ""}${randomUUID().replaceAll("-", "")}`;
}

type ActiveInvocation = Readonly<{
  terminate: () => void;
  settled: Promise<void>;
}>;

type BashExecution = Parameters<BashOperations["exec"]>[2];

function managedEnvironment(request: SandboxManagedRequest): NodeJS.ProcessEnv {
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  const currentPath = process.env[pathKey] ?? "";
  const binDir = join(getAgentDir(), "bin");
  const entries = currentPath.split(delimiter).filter(Boolean);
  const env = {
    ...process.env,
    [pathKey]: entries.includes(binDir)
      ? currentPath
      : [binDir, currentPath].filter(Boolean).join(delimiter),
  };
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;
  env.PI_SESSION_ID = request.ctx.sessionManager.getSessionId();
  const sessionFile = request.ctx.sessionManager.getSessionFile();
  if (sessionFile) {
    env.PI_SESSION_FILE = sessionFile;
  }
  if (request.ctx.model) {
    env.PI_PROVIDER = request.ctx.model.provider;
    env.PI_MODEL = request.ctx.model.id;
  }
  if (request.ctx.thinkingLevel) {
    env.PI_REASONING_LEVEL = request.ctx.thinkingLevel;
  }
  return env;
}

function timeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) {
    return undefined;
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const milliseconds = timeout * 1000;
  if (milliseconds > MAX_TIMEOUT_MS) {
    throw new Error(
      `Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`,
    );
  }
  return milliseconds;
}

function terminate(child: ChildProcess): void {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {}
  }
}

async function waitForProcessTree(
  pid: number,
  deadline = Date.now() + TERMINATION_WAIT_MS,
): Promise<boolean> {
  if (process.platform === "win32") {
    return true;
  }
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(TERMINATION_POLL_MS, remaining)),
    );
  }
}

function sandboxRejected(output: Buffer): boolean {
  return /(?:^|\n)sandbox-exec(?:\[\d+\])?:/m.test(output.toString());
}

function appendLaunchDiagnostic(output: Buffer, data: Buffer): Buffer {
  const combined = Buffer.concat([output, data]);
  return combined.length > MAX_LAUNCH_DIAGNOSTIC_BYTES
    ? combined.subarray(-MAX_LAUNCH_DIAGNOSTIC_BYTES)
    : combined;
}

export type SandboxBashRuntime = Readonly<{
  operations: BashOperations;
  startManaged: (
    request: SandboxManagedRequest,
  ) => Promise<SandboxExecutionLease>;
  dispose: () => Promise<void>;
}>;

export type SandboxSpawn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;

export function createSandboxBashRuntime(
  options: Readonly<{
    policy?: SandboxPolicy;
    enabled: () => boolean;
    supportedMac?: boolean;
    unavailableReason?: string;
    shellPath?: string;
    spawn?: SandboxSpawn;
    sandboxExecutable?: string;
    denialObserver?: SandboxDenialObserver;
    outputDrainTimeoutMs?: number;
  }>,
): SandboxBashRuntime {
  const local = createLocalBashOperations({ shellPath: options.shellPath });
  const active = new Set<ActiveInvocation>();
  const managed = new Set<{
    stop: (
      termination: "stopped" | "shutdown",
    ) => Promise<SandboxExecutionTerminal>;
  }>();
  const supportedMac = options.supportedMac ?? process.platform === "darwin";
  let disposed = false;
  let disposing: Promise<void> | undefined;

  const localOperations: BashOperations = {
    async exec(command, cwd, execution) {
      if (disposed) {
        throw new Error("Sandbox: Bash is shutting down.");
      }
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      if (execution.signal?.aborted) {
        forwardAbort();
      } else {
        execution.signal?.addEventListener("abort", forwardAbort, {
          once: true,
        });
      }
      let settleInvocation: () => void = () => undefined;
      const invocation: ActiveInvocation = {
        terminate: forwardAbort,
        settled: new Promise<void>((settle) => (settleInvocation = settle)),
      };
      active.add(invocation);
      try {
        return await local.exec(command, cwd, {
          ...execution,
          signal: controller.signal,
        });
      } finally {
        execution.signal?.removeEventListener("abort", forwardAbort);
        active.delete(invocation);
        settleInvocation();
      }
    },
  };

  const protectedOperations: BashOperations = {
    async exec(command, cwd, execution) {
      if (disposed) {
        throw new Error("Sandbox: Bash is shutting down.");
      }
      if (!options.policy) {
        throw new Error(
          options.unavailableReason ?? "Sandbox: Bash is unavailable.",
        );
      }
      if (execution.signal?.aborted) {
        throw new Error("aborted");
      }
      const timeout = timeoutMs(execution.timeout);
      const configuredShell = getShellConfig(options.shellPath);
      const shell = {
        shell: configuredShell.shell,
        args:
          configuredShell.commandTransport === "stdin"
            ? configuredShell.args
            : ["-s"],
      };
      const marker = denialMarker();
      const args = sandboxArguments({
        policy: options.policy,
        shell,
        marker,
      });
      return new Promise<{ exitCode: number | null }>(
        (resolveResult, reject) => {
          let child: ChildProcess;
          let timer: NodeJS.Timeout | undefined;
          let outputDrainTimer: NodeJS.Timeout | undefined;
          let abort: (() => void) | undefined;
          let finished = false;
          let completing = false;
          let terminationError: Error | undefined;
          let terminatedPid: number | undefined;
          let invocation: ActiveInvocation | undefined;
          let settleInvocation: () => void = () => undefined;
          let launchDiagnostics = Buffer.alloc(0);
          let launchConfirmed = false;
          let exitedCode: number | null | undefined;
          let launchOutput = Buffer.alloc(0);
          let releaseDenial: (() => void) | undefined;
          const launchMarker = Buffer.from(LAUNCH_MARKER);
          const cleanup = () => {
            if (timer) {
              clearTimeout(timer);
            }
            if (outputDrainTimer) {
              clearTimeout(outputDrainTimer);
            }
            if (abort) {
              execution.signal?.removeEventListener("abort", abort);
            }
            if (invocation) {
              active.delete(invocation);
            }
            releaseDenial?.();
            settleInvocation();
          };
          const finish = (result: { exitCode: number | null } | Error) => {
            if (finished) {
              return;
            }
            finished = true;
            cleanup();
            result instanceof Error ? reject(result) : resolveResult(result);
          };
          const stop = (error: Error) => {
            if (terminationError) {
              return;
            }
            terminationError = error;
            terminatedPid = child.pid;
            terminate(child);
          };
          try {
            releaseDenial = options.denialObserver?.registerBashInvocation(
              marker,
              (denial) => {
                if (!finished) {
                  execution.onData(
                    Buffer.from(formatSandboxWriteDenial(denial)),
                  );
                }
              },
            );
            child = (options.spawn ?? spawn)(
              options.sandboxExecutable ?? SANDBOX_EXECUTABLE,
              args,
              {
                cwd,
                detached: process.platform !== "win32",
                env: execution.env ?? process.env,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
              },
            );
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          invocation = {
            terminate: () => stop(new Error("aborted")),
            settled: new Promise<void>((settle) => (settleInvocation = settle)),
          };
          active.add(invocation);
          const complete = (exitCode: number | null) => {
            if (completing || finished) {
              return;
            }
            completing = true;
            void (async () => {
              if (
                terminationError &&
                terminatedPid !== undefined &&
                !(await waitForProcessTree(terminatedPid))
              ) {
                finish(
                  new Error(
                    `${terminationError.message}; process tree did not terminate`,
                  ),
                );
                return;
              }
              if (!terminationError && !launchConfirmed) {
                const diagnostic = launchDiagnostics.toString().trim();
                const failure = sandboxRejected(launchDiagnostics)
                  ? "sandbox-exec rejected the launch"
                  : "sandbox-exec exited before shell startup";
                finish(
                  new Error(
                    `Sandbox: ${failure}: ${diagnostic || `exit code ${exitCode ?? "unknown"}`}`,
                  ),
                );
                return;
              }
              finish(terminationError ?? { exitCode });
            })();
          };
          const refreshOutputDrain = () => {
            const exitCode = exitedCode;
            if (exitCode === undefined) {
              return;
            }
            if (outputDrainTimer) {
              clearTimeout(outputDrainTimer);
            }
            outputDrainTimer = setTimeout(() => {
              child.stdout?.destroy();
              child.stderr?.destroy();
              complete(exitCode);
            }, options.outputDrainTimeoutMs ?? OUTPUT_DRAIN_TIMEOUT_MS);
          };
          const onData = (data: Buffer) => {
            refreshOutputDrain();
            execution.onData(data);
          };
          const onStderr = (data: Buffer) => {
            if (!launchConfirmed) {
              launchDiagnostics = appendLaunchDiagnostic(
                launchDiagnostics,
                data,
              );
            }
            onData(data);
          };
          const onStdout = (data: Buffer) => {
            if (launchConfirmed) {
              onData(data);
              return;
            }
            launchDiagnostics = appendLaunchDiagnostic(launchDiagnostics, data);
            launchOutput = Buffer.concat([launchOutput, data]);
            const markerIndex = launchOutput.indexOf(launchMarker);
            if (markerIndex >= 0) {
              const prefix = launchOutput.subarray(0, markerIndex);
              const remainder = launchOutput.subarray(
                markerIndex + launchMarker.length,
              );
              launchConfirmed = true;
              launchOutput = Buffer.alloc(0);
              if (prefix.length) {
                onData(prefix);
              }
              if (remainder.length) {
                onData(remainder);
              }
              return;
            }
            const flushLength = Math.max(
              0,
              launchOutput.length - launchMarker.length + 1,
            );
            if (flushLength > 0) {
              onData(launchOutput.subarray(0, flushLength));
              launchOutput = launchOutput.subarray(flushLength);
            }
          };
          child.stdout?.on("data", onStdout);
          child.stderr?.on("data", onStderr);
          child.once("error", (error) => {
            if (child.pid) {
              stop(terminationError ?? error);
            } else {
              finish(new Error(`Sandbox: launch failed: ${error.message}`));
            }
          });
          child.once("exit", (exitCode) => {
            exitedCode = exitCode;
            refreshOutputDrain();
          });
          child.once("close", complete);
          abort = () => stop(new Error("aborted"));
          execution.signal?.addEventListener("abort", abort, { once: true });
          if (timeout !== undefined) {
            timer = setTimeout(
              () => stop(new Error(`timeout:${execution.timeout}`)),
              timeout,
            );
          }
          child.stdin?.on("error", () => undefined);
          child.stdin?.end(`${LAUNCH_PREFIX}${command}`);
        },
      );
    },
  };

  const startManaged = async (
    request: SandboxManagedRequest,
  ): Promise<SandboxExecutionLease> => {
    if (disposed) {
      throw new Error("Sandbox: Bash is shutting down.");
    }
    if (request.signal?.aborted) {
      throw new Error("aborted");
    }
    if (supportedMac && options.enabled() && !options.policy) {
      throw new Error(
        options.unavailableReason ?? "Sandbox: Bash is unavailable.",
      );
    }
    const shell = getShellConfig(options.shellPath);
    const protectedLaunch = supportedMac && options.enabled();
    const marker = protectedLaunch
      ? denialMarker(request.toolCallId)
      : undefined;
    const shellArgs =
      shell.commandTransport === "stdin"
        ? shell.args
        : [...shell.args, request.command];
    const args = protectedLaunch
      ? sandboxArguments({
          policy: options.policy!,
          shell: {
            shell: shell.shell,
            args: shell.commandTransport === "stdin" ? shell.args : ["-s"],
          },
          marker: marker!,
        })
      : shellArgs;
    const executable = protectedLaunch
      ? (options.sandboxExecutable ?? SANDBOX_EXECUTABLE)
      : shell.shell;
    let child: ChildProcess;
    try {
      child = (options.spawn ?? spawn)(executable, args, {
        cwd: request.cwd,
        detached: process.platform !== "win32",
        env: managedEnvironment(request),
        stdio: [
          shell.commandTransport === "stdin" || protectedLaunch
            ? "pipe"
            : "ignore",
          "pipe",
          "pipe",
        ],
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(
        `Sandbox: launch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let termination: "natural" | "stopped" | "shutdown" = "natural";
    let settled = false;
    let exited = false;
    let streamsClosed = 0;
    let outputComplete = true;
    let drainTimer: NodeJS.Timeout | undefined;
    let resolveTerminal: (terminal: SandboxExecutionTerminal) => void = () =>
      undefined;
    let rejectTerminal: (error: Error) => void = () => undefined;
    let groupSettlement: Promise<void> | undefined;
    const completion = new Promise<SandboxExecutionTerminal>(
      (resolve, reject) => {
        resolveTerminal = resolve;
        rejectTerminal = reject;
      },
    );
    let resolveLaunch: () => void = () => undefined;
    let rejectLaunch: (error: Error) => void = () => undefined;
    let launchConfirmed = false;
    const launch = new Promise<void>((resolve, reject) => {
      resolveLaunch = resolve;
      rejectLaunch = reject;
    });
    const confirmLaunch = () => {
      if (!launchConfirmed) {
        launchConfirmed = true;
        resolveLaunch();
      }
    };
    let owner:
      | {
          stop: (
            termination: "stopped" | "shutdown",
          ) => Promise<SandboxExecutionTerminal>;
        }
      | undefined;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (drainTimer) {
          clearTimeout(drainTimer);
        }
        if (owner) {
          managed.delete(owner);
        }
        releaseDenial?.();
        resolveTerminal({ exitCode, signal, termination, outputComplete });
      };
      if (groupSettlement) {
        void groupSettlement.then(settle, (error: unknown) => {
          if (!settled) {
            settled = true;
            if (drainTimer) {
              clearTimeout(drainTimer);
            }
            if (owner) {
              managed.delete(owner);
            }
            releaseDenial?.();
            rejectTerminal(
              error instanceof Error
                ? error
                : new Error("Sandbox: process group did not terminate"),
            );
          }
        });
      } else {
        settle();
      }
    };
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    const maybeFinish = () => {
      if (exited && streamsClosed >= 2) {
        finish(exitCode, exitSignal);
      }
    };
    const closeStream = () => {
      streamsClosed += 1;
      maybeFinish();
    };
    let launchOutput = Buffer.alloc(0);
    let launchDiagnostics = Buffer.alloc(0);
    const releaseDenial = protectedLaunch
      ? options.denialObserver?.registerBashInvocation(marker!, (denial) => {
          request.onOutput({
            stream: "stderr",
            data: Buffer.from(formatSandboxWriteDenial(denial)),
          });
        })
      : undefined;
    child.stdout?.on("data", (data: Buffer) => {
      if (!protectedLaunch) {
        request.onOutput({ stream: "stdout", data });
        return;
      }
      launchOutput = Buffer.concat([launchOutput, data]);
      const markerIndex = launchOutput.indexOf(LAUNCH_MARKER);
      if (markerIndex < 0) {
        const flushLength = Math.max(
          0,
          launchOutput.length - LAUNCH_MARKER.length + 1,
        );
        if (flushLength > 0) {
          request.onOutput({
            stream: "stdout",
            data: launchOutput.subarray(0, flushLength),
          });
          launchOutput = launchOutput.subarray(flushLength);
        }
        return;
      }
      const before = launchOutput.subarray(0, markerIndex);
      const after = launchOutput.subarray(markerIndex + LAUNCH_MARKER.length);
      launchOutput = Buffer.alloc(0);
      confirmLaunch();
      if (before.length) {
        request.onOutput({ stream: "stdout", data: before });
      }
      if (after.length) {
        request.onOutput({ stream: "stdout", data: after });
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (protectedLaunch && !launchConfirmed) {
        launchDiagnostics = appendLaunchDiagnostic(launchDiagnostics, data);
      }
      request.onOutput({ stream: "stderr", data });
    });
    child.stdout?.once("close", closeStream);
    child.stderr?.once("close", closeStream);
    child.once("error", (error) => {
      if (!launchConfirmed) {
        rejectLaunch(new Error(`Sandbox: launch failed: ${error.message}`));
      }
      if (!exited) {
        termination = termination === "natural" ? "natural" : termination;
        exitCode = 1;
        finish(exitCode, null);
      }
    });
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      if (protectedLaunch && !launchConfirmed) {
        const diagnostic = launchDiagnostics.toString().trim();
        const failure = sandboxRejected(launchDiagnostics)
          ? "sandbox-exec rejected the launch"
          : "sandbox-exec exited before shell startup";
        rejectLaunch(
          new Error(
            `Sandbox: ${failure}: ${diagnostic || `exit code ${code ?? "unknown"}`}`,
          ),
        );
      }
      maybeFinish();
      if (!settled && streamsClosed < 2) {
        drainTimer = setTimeout(() => {
          outputComplete = false;
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(exitCode, exitSignal);
        }, options.outputDrainTimeoutMs ?? OUTPUT_DRAIN_TIMEOUT_MS);
      }
    });
    const stop = async (kind: "stopped" | "shutdown") => {
      if (settled) {
        return completion;
      }
      termination = kind;
      if (!groupSettlement) {
        const pid = child.pid;
        groupSettlement = (async () => {
          if (!pid) {
            return;
          }
          const deadline = Date.now() + TERMINATION_WAIT_MS;
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            try {
              child.kill("SIGTERM");
            } catch {}
          }
          if (!(await waitForProcessTree(pid, deadline))) {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              try {
                child.kill("SIGKILL");
              } catch {}
            }
            if (!(await waitForProcessTree(pid, deadline))) {
              throw new Error("Sandbox: process group did not terminate");
            }
          }
        })();
      }
      await groupSettlement;
      return completion;
    };
    owner = { stop };
    managed.add(owner);
    const abort = () => {
      if (!launchConfirmed) {
        rejectLaunch(new Error("aborted"));
      }
      void stop("stopped");
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (protectedLaunch) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(`${LAUNCH_PREFIX}${request.command}`);
      } else if (shell.commandTransport === "stdin") {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(request.command);
      }
      if (!protectedLaunch) {
        setImmediate(confirmLaunch);
      }
      await launch;
      request.signal?.removeEventListener("abort", abort);
    } catch (error) {
      request.signal?.removeEventListener("abort", abort);
      await stop("stopped");
      throw error;
    }
    if (!child.pid) {
      throw new Error("Sandbox: launch failed.");
    }
    return { pid: child.pid, completion, stop: () => stop("stopped") };
  };

  return {
    operations: {
      exec(command, cwd, execution: BashExecution) {
        if (disposed) {
          return Promise.reject(new Error("Sandbox: Bash is shutting down."));
        }
        if (!supportedMac || !options.enabled()) {
          return localOperations.exec(command, cwd, execution);
        }
        return protectedOperations.exec(command, cwd, execution);
      },
    },
    startManaged,
    async dispose() {
      if (!disposing) {
        disposed = true;
        const invocations = [...active];
        for (const invocation of invocations) {
          invocation.terminate();
        }
        const leases = [...managed];
        disposing = Promise.all([
          ...invocations.map((invocation) => invocation.settled),
          ...leases.map((lease) => lease.stop("shutdown")),
        ]).then(() => undefined);
      }
      await disposing;
    },
  };
}

export function createSandboxBashDefinition(
  sessionCwd: string,
  runtime: SandboxBashRuntime,
  shellPath?: string,
) {
  return createBashToolDefinition(sessionCwd, {
    operations: runtime.operations,
    shellPath,
  });
}
