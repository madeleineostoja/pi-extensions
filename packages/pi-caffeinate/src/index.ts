import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG_PATH = (() => {
  const dir = join(homedir(), ".pi", "agent", "logs");
  try {
    mkdirSync(dir, { recursive: true });
    return join(dir, "pi-caffeinate.log");
  } catch {
    return join(tmpdir(), "pi-caffeinate.log");
  }
})();

const log = (msg: string) => {
  try {
    appendFileSync(
      LOG_PATH,
      `${new Date().toISOString()} [pid ${process.pid}] ${msg}\n`,
    );
  } catch {
    // best-effort
  }
};

/**
 * pi-caffeinate
 * Keeps the host awake for the lifetime of the pi session.
 */
export default function (pi: ExtensionAPI) {
  let inhibitor: ChildProcess | null = null;

  log(`factory invoked (platform=${process.platform})`);

  const start = () => {
    if (inhibitor) {
      log(
        `start() called but inhibitor already running (child pid=${inhibitor.pid})`,
      );
      return;
    }

    const pid = String(process.pid);
    let cmd: string;
    let args: string[];
    if (process.platform === "darwin") {
      cmd = "caffeinate";
      args = ["-i", "-w", pid];
    } else if (process.platform === "linux") {
      // `tail --pid` is GNU coreutils, which ships on every distro that has
      // systemd-inhibit. When pid exits, tail exits, systemd-inhibit
      // releases the lock.
      cmd = "systemd-inhibit";
      args = [
        "--what=idle:sleep",
        "--why=pi session is open",
        "--",
        "tail",
        "--pid",
        pid,
        "-f",
        "/dev/null",
      ];
    } else {
      log(`unsupported platform=${process.platform}, no-op`);
      return;
    }

    try {
      log(`spawning: ${cmd} ${args.join(" ")}`);
      const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
      log(`spawned child pid=${child.pid}`);
      child.stderr?.on("data", (chunk: Buffer) => {
        log(`child stderr: ${chunk.toString().trimEnd()}`);
      });
      child.once("error", (err) => {
        log(`child error: ${err.message}`);
        if (inhibitor === child) {
          inhibitor = null;
        }
      });
      child.once("exit", (code, signal) => {
        log(`child exit code=${code} signal=${signal}`);
        if (inhibitor === child) {
          inhibitor = null;
        }
      });
      inhibitor = child;
    } catch (err) {
      log(`spawn threw: ${err instanceof Error ? err.message : String(err)}`);
      inhibitor = null;
    }
  };

  const stop = () => {
    const child = inhibitor;
    inhibitor = null;
    if (!child) {
      log(`stop() called, no inhibitor`);
      return;
    }
    log(`stop() killing child pid=${child.pid}`);
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  };

  // Best-effort cleanup if Node exits without going through session_shutdown
  // (e.g. uncaught error). For raw signals or SIGKILL, we rely on the child
  // watching pi's PID and exiting on its own.
  const onProcessExit = () => stop();
  process.on("exit", onProcessExit);

  pi.on("session_start", (event: { reason?: string } = {}) => {
    log(`session_start (reason=${event.reason ?? "?"})`);
    start();
  });

  pi.on("session_shutdown", () => {
    log(`session_shutdown`);
    stop();
    process.removeListener("exit", onProcessExit);
  });
}
