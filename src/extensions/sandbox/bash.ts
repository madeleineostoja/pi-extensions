import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  getShellConfig,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import {
  formatSandboxWriteDenial,
  type SandboxDenialObserver,
} from "./denial-observer.js";
import type { SandboxPolicy } from "./policy.js";
import { SANDBOX_EXECUTABLE, sandboxArguments } from "./seatbelt.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
const TERMINATION_WAIT_MS = 5_000;
const TERMINATION_POLL_MS = 10;
const OUTPUT_DRAIN_TIMEOUT_MS = 2_000;
const LAUNCH_MARKER = "__PIPKIN_SANDBOX_LAUNCHED__\n";
const LAUNCH_PREFIX = `printf '${LAUNCH_MARKER}'\n`;
const MAX_LAUNCH_DIAGNOSTIC_BYTES = 64 * 1024;

function denialMarker(): string {
  return `PIPKIN_${randomUUID().replaceAll("-", "")}`;
}

type ActiveInvocation = Readonly<{
  terminate: () => void;
  settled: Promise<void>;
}>;

type BashExecution = Parameters<BashOperations["exec"]>[2];

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

async function waitForProcessTree(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    return true;
  }
  const deadline = Date.now() + TERMINATION_WAIT_MS;
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, TERMINATION_POLL_MS));
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
    async dispose() {
      if (!disposing) {
        disposed = true;
        const invocations = [...active];
        for (const invocation of invocations) {
          invocation.terminate();
        }
        disposing = Promise.allSettled(
          invocations.map((invocation) => invocation.settled),
        ).then(() => undefined);
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
