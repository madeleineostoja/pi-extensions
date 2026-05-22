import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-caffeinate (lightweight)
 *
 * Keeps the host awake for the lifetime of the pi session.
 *
 * macOS:  caffeinate -i -w <pid>
 * Linux:  systemd-inhibit --what=idle:sleep --why=... -- tail --pid <pid> -f /dev/null
 * Other:  no-op
 *
 * The child watches pi's PID and exits on its own when pi dies, so the
 * inhibitor is released even if pi is killed with SIGKILL and our
 * shutdown handlers never run.
 */
export default function (pi: ExtensionAPI) {
  let inhibitor: ChildProcess | null = null;

  const start = () => {
    if (inhibitor) return;

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
      return;
    }

    try {
      const child = spawn(cmd, args, { stdio: "ignore" });
      child.once("error", () => {
        if (inhibitor === child) inhibitor = null;
      });
      child.once("exit", () => {
        if (inhibitor === child) inhibitor = null;
      });
      inhibitor = child;
    } catch {
      inhibitor = null;
    }
  };

  const stop = () => {
    const child = inhibitor;
    inhibitor = null;
    if (!child) return;
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

  pi.on("session_start", () => {
    start();
  });

  pi.on("session_shutdown", () => {
    stop();
    process.removeListener("exit", onProcessExit);
  });
}
