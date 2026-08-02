import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { SandboxDenialRecorder } from "./denials.js";

const LOG_EXECUTABLE = "/usr/bin/log";
const MARKER_PREFIX = "PIPKIN_";
const REPORT_RETENTION_MS = 5_000;
const LOG_PREDICATE = `eventMessage CONTAINS[c] "${MARKER_PREFIX}"`;

type BashInvocation = {
  timer?: NodeJS.Timeout;
  onWriteDenial?: (denial: SandboxWriteDenial) => void;
  release: () => void;
};

export type SandboxWriteDenial = Readonly<{
  process: string;
  pid: number;
  operation: string;
  path: string;
}>;

export type SandboxLogSpawn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;

export type SandboxDenialObserver = Readonly<{
  start: () => void;
  registerBashInvocation: (
    marker: string,
    onWriteDenial?: (denial: SandboxWriteDenial) => void,
  ) => () => void;
  dispose: () => Promise<void>;
}>;

export function parseSandboxWriteDenial(
  message: unknown,
): SandboxWriteDenial | undefined {
  if (typeof message !== "string") {
    return undefined;
  }
  for (const line of message.split("\n")) {
    const match =
      /^Sandbox: ([^(]+)\((\d+)\) deny\(\d+\) (file-write\S*) (.+)$/.exec(line);
    if (match) {
      return {
        process: match[1],
        pid: Number(match[2]),
        operation: match[3],
        path: match[4],
      };
    }
  }
  return undefined;
}

function markerIn(
  message: string,
  markers: Map<string, BashInvocation>,
): BashInvocation | undefined {
  for (const line of message.split("\n")) {
    const invocation = markers.get(line);
    if (invocation) {
      return invocation;
    }
  }
  return undefined;
}

function bounded(value: string): string {
  return Array.from(value, (character) =>
    /\p{C}/u.test(character) ? "�" : character,
  )
    .join("")
    .slice(0, 512);
}

export function formatSandboxWriteDenial(denial: SandboxWriteDenial): string {
  return `\nSandbox: the active repository-write Sandbox blocked ${bounded(denial.operation)} ${bounded(denial.path)} (${bounded(denial.process)}, pid ${denial.pid}). Use an allowed writable root; do not change Sandbox settings unless the user asks.\n`;
}

export function createSandboxDenialObserver(options: {
  denials: SandboxDenialRecorder;
  spawn?: SandboxLogSpawn;
}): SandboxDenialObserver {
  const markers = new Map<string, BashInvocation>();
  const spawnLog = options.spawn ?? spawn;
  let child: ChildProcess | undefined;
  let dispose: Promise<void> | undefined;
  let buffer = "";
  const decoder = new StringDecoder("utf8");

  const consumeLine = (line: string) => {
    try {
      const message = JSON.parse(line).eventMessage;
      const denial = parseSandboxWriteDenial(message);
      const invocation =
        typeof message === "string" ? markerIn(message, markers) : undefined;
      if (denial && invocation) {
        options.denials.recordBash(denial);
        try {
          invocation.onWriteDenial?.(denial);
        } catch {}
      }
    } catch {}
  };
  const consume = (text: string, flush = false) => {
    buffer += text;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      consumeLine(line);
    }
    if (flush && buffer) {
      consumeLine(buffer);
      buffer = "";
    }
  };

  return {
    start() {
      if (child || dispose) {
        return;
      }
      try {
        const current = spawnLog(
          LOG_EXECUTABLE,
          [
            "stream",
            "--style",
            "ndjson",
            "--level",
            "debug",
            "--predicate",
            LOG_PREDICATE,
          ],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        child = current;
        current.stdout?.on("data", (data: Buffer) =>
          consume(decoder.write(data)),
        );
        current.stderr?.resume();
        current.once("close", () => {
          consume(decoder.end(), true);
          if (child === current) {
            child = undefined;
          }
        });
        current.once("error", () => {
          if (child === current) {
            child = undefined;
          }
        });
      } catch {}
    },
    registerBashInvocation(marker, onWriteDenial) {
      if (
        !marker.startsWith(MARKER_PREFIX) ||
        !/^[A-Za-z0-9_]+$/.test(marker)
      ) {
        throw new Error("Sandbox: invalid denial marker.");
      }
      const invocation: BashInvocation = {
        onWriteDenial,
        release: () => {
          if (invocation.timer) {
            return;
          }
          invocation.timer = setTimeout(
            () => markers.delete(marker),
            REPORT_RETENTION_MS,
          );
          invocation.timer.unref();
        },
      };
      markers.set(marker, invocation);
      return invocation.release;
    },
    async dispose() {
      if (!dispose) {
        for (const invocation of markers.values()) {
          if (invocation.timer) {
            clearTimeout(invocation.timer);
          }
        }
        markers.clear();
        const active = child;
        child = undefined;
        dispose = new Promise<void>((resolve) => {
          if (!active || active.exitCode !== null || active.killed) {
            resolve();
            return;
          }
          const settled = () => resolve();
          active.once("close", settled);
          active.once("error", settled);
          active.kill();
        });
      }
      await dispose;
    },
  };
}
