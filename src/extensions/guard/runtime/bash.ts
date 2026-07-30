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

export type GuardBashRuntime = {
  agentOperations: BashOperations;
  userOperations: BashOperations;
  dispose: () => void;
};

export function createGuardBashRuntime(options: {
  state: GuardRuntimeState;
  supportedMac: boolean;
}): GuardBashRuntime {
  const local = createLocalBashOperations();
  const active = new Set<ChildProcess>();

  const nono: BashOperations = {
    async exec(command, cwd, execution) {
      const fixed = options.state.fixedCapabilities();
      const health = options.state.backendHealth();
      if (!fixed || health?.kind !== "healthy") {
        throw new Error("Guard: Nono Bash boundary is unavailable.");
      }
      const manifest = writeNonoManifest(
        buildNonoManifest(fixed, options.state.filesystemGrants()),
      );
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      try {
        if (execution.signal?.aborted) {
          throw new Error("aborted");
        }
        const shell = getShellConfig();
        const commandArgs = [
          "run",
          "--config",
          manifest.path,
          "--",
          shell.shell,
          ...shell.args,
        ];
        const commandFromStdin = shell.commandTransport === "stdin";
        if (!commandFromStdin) {
          commandArgs.push(command);
        }
        const child = spawn(health.path, commandArgs, {
          cwd,
          detached: process.platform !== "win32",
          env: execution.env,
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        active.add(child);
        if (commandFromStdin) {
          child.stdin?.on("error", () => undefined);
          child.stdin?.end(command);
        }
        const result = await new Promise<{ exitCode: number | null }>(
          (resolve, reject) => {
            let done = false;
            const finish = (callback: () => void) => {
              if (done) {
                return;
              }
              done = true;
              if (timer) {
                clearTimeout(timer);
              }
              if (onAbort) {
                execution.signal?.removeEventListener("abort", onAbort);
              }
              active.delete(child);
              callback();
            };
            onAbort = () => {
              terminate(child);
              finish(() => reject(new Error("aborted")));
            };
            execution.signal?.addEventListener("abort", onAbort, {
              once: true,
            });
            const ms = timeoutMs(execution.timeout);
            if (ms !== undefined) {
              timer = setTimeout(() => {
                terminate(child);
                finish(() => reject(new Error(`timeout:${execution.timeout}`)));
              }, ms);
            }
            child.stdout?.on("data", execution.onData);
            child.stderr?.on("data", execution.onData);
            child.once("error", (error) => finish(() => reject(error)));
            child.once("close", (exitCode) =>
              finish(() => resolve({ exitCode })),
            );
          },
        );
        return result;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        if (onAbort) {
          execution.signal?.removeEventListener("abort", onAbort);
        }
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
    dispose() {
      for (const child of active) {
        terminate(child);
      }
      active.clear();
    },
  };
}
