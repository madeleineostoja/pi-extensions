import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const logPath = (() => {
  const dir = join(getAgentDir(), "pipkin", "logs");
  try {
    mkdirSync(dir, { recursive: true });
    return join(dir, "pipkin-caffeinate.log");
  } catch {
    return join(tmpdir(), "pipkin-caffeinate.log");
  }
})();

const log = (message: string): void => {
  try {
    appendFileSync(
      logPath,
      `${new Date().toISOString()} [pid ${process.pid}] ${message}\n`,
    );
  } catch {}
};

type InhibitorChild = Pick<ChildProcess, "pid" | "stderr" | "once" | "kill">;

type InhibitorOptions = {
  platform?: NodeJS.Platform;
  pid?: number;
  spawn?: (command: string, args: string[]) => InhibitorChild;
  log?: (message: string) => void;
};

export function selectInhibitorCommand(
  platform: NodeJS.Platform,
  pid: number,
): { command: string; args: string[] } | undefined {
  if (platform === "darwin") {
    return { command: "caffeinate", args: ["-i", "-w", String(pid)] };
  }
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--why=Pipkin session is open",
        "--",
        "tail",
        "--pid",
        String(pid),
        "-f",
        "/dev/null",
      ],
    };
  }
}

export function createInhibitor(options: InhibitorOptions = {}) {
  const platform = options.platform ?? process.platform;
  const pid = options.pid ?? process.pid;
  const writeLog = options.log ?? log;
  const spawnProcess =
    options.spawn ??
    ((command: string, args: string[]): InhibitorChild =>
      spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] }));
  let inhibitor: InhibitorChild | null = null;

  writeLog(`factory invoked (platform=${platform})`);

  const start = (reason?: string): void => {
    writeLog(`session_start (reason=${reason ?? "?"})`);
    if (inhibitor) {
      writeLog(
        `start() called but inhibitor already running (child pid=${inhibitor.pid})`,
      );
      return;
    }

    const invocation = selectInhibitorCommand(platform, pid);
    if (!invocation) {
      writeLog(`unsupported platform=${platform}, no-op`);
      return;
    }

    try {
      writeLog(`spawning: ${invocation.command} ${invocation.args.join(" ")}`);
      const child = spawnProcess(invocation.command, invocation.args);
      writeLog(`spawned child pid=${child.pid}`);
      child.stderr?.on("data", (chunk: Buffer) => {
        writeLog(`child stderr: ${chunk.toString().trimEnd()}`);
      });
      child.once("error", (error) => {
        writeLog(`child error: ${error.message}`);
        if (inhibitor === child) {
          inhibitor = null;
        }
      });
      child.once("exit", (code, signal) => {
        writeLog(`child exit code=${code} signal=${signal}`);
        if (inhibitor === child) {
          inhibitor = null;
        }
      });
      inhibitor = child;
    } catch (error) {
      writeLog(
        `spawn threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      inhibitor = null;
    }
  };

  const stop = (): void => {
    const child = inhibitor;
    inhibitor = null;
    if (!child) {
      writeLog("stop() called, no inhibitor");
      return;
    }
    writeLog(`stop() killing child pid=${child.pid}`);
    try {
      child.kill("SIGTERM");
    } catch {}
  };

  const shutdown = (): void => {
    writeLog("session_shutdown");
    stop();
  };

  return { start, stop, shutdown };
}
