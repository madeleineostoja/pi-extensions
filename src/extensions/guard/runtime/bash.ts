import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  createLocalBashOperations,
  getShellConfig,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import type { GuardRuntimeState } from "../state.js";
import { buildNonoManifest, writeNonoManifest } from "./manifest.js";

const MAX_TIMEOUT_MS = 2_147_483_647;

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

type ActiveInvocation = {
  terminate: () => void;
  settled: Promise<void>;
};

export type GuardBashRuntime = {
  agentOperations: BashOperations;
  userOperations: BashOperations;
  dispose: () => Promise<void>;
};

export function createGuardBashRuntime(options: {
  state: GuardRuntimeState;
  supportedMac: boolean;
}): GuardBashRuntime {
  const local = createLocalBashOperations();
  const active = new Set<ActiveInvocation>();
  let disposed = false;
  let disposing: Promise<void> | undefined;

  const nono: BashOperations = {
    async exec(command, cwd, execution) {
      const fixed = options.state.fixedCapabilities();
      const health = options.state.backendHealth();
      if (!fixed || health?.kind !== "healthy") {
        throw new Error("Guard: Nono Bash boundary is unavailable.");
      }
      if (disposed) {
        throw new Error("Guard: Nono Bash boundary is shutting down.");
      }
      const timeout = timeoutMs(execution.timeout);
      if (execution.signal?.aborted) {
        throw new Error("aborted");
      }

      const shell = getShellConfig();
      const commandArgs = [
        "run",
        "--config",
        "",
        "--",
        shell.shell,
        ...shell.args,
      ];
      const commandFromStdin = shell.commandTransport === "stdin";
      if (!commandFromStdin) {
        commandArgs.push(command);
      }
      const manifest = writeNonoManifest(
        buildNonoManifest(fixed, options.state.filesystemGrants()),
      );
      commandArgs[2] = manifest.path;

      try {
        return await new Promise<{ exitCode: number | null }>(
          (resolve, reject) => {
            let child: ChildProcess;
            let timer: NodeJS.Timeout | undefined;
            let abort: (() => void) | undefined;
            let finished = false;
            let terminationError: Error | undefined;
            let invocation: ActiveInvocation | undefined;
            let settleInvocation: () => void = () => undefined;

            const cleanup = () => {
              if (timer) {
                clearTimeout(timer);
              }
              if (abort) {
                execution.signal?.removeEventListener("abort", abort);
              }
              if (invocation) {
                active.delete(invocation);
              }
            };
            const finish = (result: { exitCode: number | null } | Error) => {
              if (finished) {
                return;
              }
              finished = true;
              cleanup();
              manifest.cleanup();
              settleInvocation();
              if (result instanceof Error) {
                reject(result);
              } else {
                resolve(result);
              }
            };
            const stop = (error: Error) => {
              if (terminationError) {
                return;
              }
              terminationError = error;
              terminate(child);
            };

            try {
              child = spawn(health.path, commandArgs, {
                cwd,
                detached: process.platform !== "win32",
                env: execution.env,
                stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
                windowsHide: true,
              });
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
              return;
            }

            invocation = {
              terminate: () => stop(new Error("aborted")),
              settled: new Promise<void>((settle) => {
                settleInvocation = settle;
              }),
            };
            active.add(invocation);
            child.stdout?.on("data", execution.onData);
            child.stderr?.on("data", execution.onData);
            child.once("error", (error) => {
              if (child.pid) {
                stop(terminationError ?? error);
                return;
              }
              finish(error);
            });
            child.once("close", (exitCode) =>
              finish(terminationError ?? { exitCode }),
            );
            abort = () => stop(new Error("aborted"));
            execution.signal?.addEventListener("abort", abort, { once: true });
            if (timeout !== undefined) {
              timer = setTimeout(
                () => stop(new Error(`timeout:${execution.timeout}`)),
                timeout,
              );
            }
            if (commandFromStdin) {
              child.stdin?.on("error", () => undefined);
              child.stdin?.end(command);
            }
          },
        );
      } finally {
        manifest.cleanup();
      }
    },
  };

  const select = (origin: "agent" | "user"): BashOperations => ({
    exec(command, cwd, execution) {
      if (!options.supportedMac || !options.state.boundaryEnabled()) {
        return local.exec(command, cwd, execution);
      }
      if (options.state.backendHealth()?.kind === "healthy") {
        return nono.exec(command, cwd, execution);
      }
      if (origin === "user") {
        return local.exec(command, cwd, execution);
      }
      return Promise.reject(
        new Error(
          "Guard: Bash is unavailable while Nono is unhealthy. Use tools or recover Nono, then reload Pi.",
        ),
      );
    },
  });

  return {
    agentOperations: select("agent"),
    userOperations: select("user"),
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
