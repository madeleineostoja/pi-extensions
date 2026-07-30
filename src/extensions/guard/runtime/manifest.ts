import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FilesystemGrant, FixedCapabilities } from "../capabilities.js";

export type NonoManifestGrant = Readonly<{
  path: string;
  access: "read" | "write" | "readwrite";
  type: "file" | "directory";
}>;
export type NonoManifest = Readonly<{
  version: "0.1.0";
  filesystem: { grants: NonoManifestGrant[] };
  network: { mode: "unrestricted" };
}>;
export type NonoRunResult =
  | { kind: "exited"; exitCode: number | null; stdout: string; stderr: string }
  | { kind: "spawn-error" }
  | { kind: "timeout" }
  | { kind: "cancelled" };
export type NonoRunOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

function manifestGrants(
  grants: readonly FilesystemGrant[],
): NonoManifestGrant[] {
  const modes = new Map<string, Set<"read" | "write">>();
  for (const grant of grants) {
    const key = `${grant.kind}\0${grant.path}`;
    const entry = modes.get(key) ?? new Set<"read" | "write">();
    entry.add(grant.access);
    modes.set(key, entry);
  }
  return [...modes].map(([key, access]) => {
    const [type, path] = key.split("\0") as ["file" | "directory", string];
    return {
      path,
      type,
      access:
        access.size === 2 ? "readwrite" : access.has("read") ? "read" : "write",
    };
  });
}

export function buildNonoManifest(fixed: FixedCapabilities): NonoManifest {
  return {
    version: "0.1.0",
    filesystem: { grants: manifestGrants(fixed.grants) },
    network: { mode: "unrestricted" },
  };
}

export type NonoManifestFile = Readonly<{
  path: string;
  cleanup: () => void;
}>;

export function writeNonoManifest(manifest: NonoManifest): NonoManifestFile {
  const directory = mkdtempSync(join(tmpdir(), "pipkin-nono-run-"));
  const path = join(directory, "pipkin-nono-manifest.json");
  try {
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
  } catch (error) {
    cleanupDirectory(directory);
    throw error;
  }
  let removed = false;
  return {
    path,
    cleanup() {
      if (!removed) {
        removed = true;
        cleanupDirectory(directory);
      }
    },
  };
}

function cleanupDirectory(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {}
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) {
    return;
  }
  signalProcessGroup(pid, "SIGTERM");
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  signalProcessGroup(pid, "SIGKILL");
}

async function runNonoProcess(
  binary: string,
  commandArgs: readonly string[],
  options: NonoRunOptions,
): Promise<NonoRunResult> {
  if (options.signal?.aborted) {
    return { kind: "cancelled" };
  }
  try {
    return await new Promise<NonoRunResult>((settle) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let timeout: NodeJS.Timeout | undefined;
      let terminating = false;
      let abort: () => void = () => undefined;
      let closed: () => void = () => undefined;
      const childClosed = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const finish = (result: NonoRunResult) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        options.signal?.removeEventListener("abort", abort);
        settle(result);
      };
      const child = spawn(resolve(binary), commandArgs, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const terminate = (result: NonoRunResult) => {
        if (settled || terminating) {
          return;
        }
        terminating = true;
        void terminateProcessTree(child.pid).then(
          async () => {
            await childClosed;
            finish(result);
          },
          () => finish(result),
        );
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < 4096) {
          stdout += chunk.toString().slice(0, 4096 - stdout.length);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 4096) {
          stderr += chunk.toString().slice(0, 4096 - stderr.length);
        }
      });
      abort = () => terminate({ kind: "cancelled" });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(
          () => terminate({ kind: "timeout" }),
          options.timeoutMs,
        );
      }
      child.once("error", () => {
        closed();
        if (!terminating) {
          finish({ kind: "spawn-error" });
        }
      });
      child.once("close", (exitCode) => {
        closed();
        if (!terminating) {
          finish({ kind: "exited", exitCode, stdout, stderr });
        }
      });
    });
  } catch {
    return { kind: "spawn-error" };
  }
}

export function runNonoCommand(
  binary: string,
  args: readonly string[],
  options: NonoRunOptions = {},
): Promise<NonoRunResult> {
  return runNonoProcess(binary, args, options);
}

export async function runNono(
  binary: string,
  manifest: NonoManifestFile,
  command: string,
  args: readonly string[],
  options: NonoRunOptions = {},
): Promise<NonoRunResult> {
  try {
    return await runNonoProcess(
      binary,
      ["run", "--config", manifest.path, "--", command, ...args],
      options,
    );
  } finally {
    manifest.cleanup();
  }
}
