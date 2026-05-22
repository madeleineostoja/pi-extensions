import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

export type BinaryStatus =
  | { kind: "ok"; path: string; version: string }
  | { kind: "platform-unsupported"; platform: string }
  | { kind: "install-failed"; reason: string; detail?: string };

export function pkgRoot(): string {
  return path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
}

export function pinnedVersion(): string {
  try {
    const pkg = _require(path.join(pkgRoot(), "package.json")) as { nonoVersion?: string };
    return pkg.nonoVersion ?? "unknown";
  } catch {
    return "unknown";
  }
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichInPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function resolveNonoPath(root: string, pathEnv: string): string | null {
  const pkgBin = path.join(root, "bin", "nono");
  if (isExecutable(pkgBin)) return pkgBin;

  const onPath = whichInPath("nono", pathEnv);
  if (onPath) return onPath;

  return null;
}

/**
 * Run `nono --version` and return the version string, or null if it fails.
 */
export function readNonoVersion(binPath: string): string | null {
  try {
    const out = execFileSync(binPath, ["--version"], {
      timeout: 5000,
      encoding: "utf8",
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Check the resolved binary version against the pinned version and emit a warning
 * via the provided notify function if they differ.
 */
export function checkNonoVersion(
  binPath: string,
  notify: (msg: string, level: "warning" | "error") => void
): void {
  const actual = readNonoVersion(binPath);
  if (actual === null) return;

  const pinned = pinnedVersion();
  if (pinned === "unknown") return;

  const actualVersion = actual.replace(/^nono\s+v?/i, "").replace(/^v/, "");
  const pinnedVersion_ = pinned.replace(/^v/, "");

  if (actualVersion !== pinnedVersion_) {
    notify(
      `pi-sandbox: nono version mismatch — expected v${pinnedVersion_}, found "${actual}". ` +
        "This may cause compatibility issues. Continuing anyway.",
      "warning"
    );
  }
}

export interface IsMuslResult {
  isMusl: boolean;
}

/**
 * Detect whether we're running on a musl-based Linux system.
 * Uses process.report.getReport().header.glibcVersionRuntime: if undefined on Linux, assume musl.
 */
export function detectMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    if (report?.header !== undefined) {
      return report.header.glibcVersionRuntime === undefined;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Determine whether the current platform is supported for nono binary download.
 */
export function isSupportedPlatform(): boolean {
  const { platform, arch } = process;
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return true;
  if (platform === "linux" && !detectMusl() && (arch === "arm64" || arch === "x64")) return true;
  return false;
}

interface InstallStatusOk {
  ok: true;
  version: string;
  ts: number;
}

interface InstallStatusFail {
  ok: false;
  reason: string;
  detail?: string;
  ts: number;
}

type InstallStatus = InstallStatusOk | InstallStatusFail;

function readInstallStatus(root: string): InstallStatus | null {
  const statusPath = path.join(root, "bin", ".install-status.json");
  try {
    const raw = fs.readFileSync(statusPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.ok === true) {
      if (typeof parsed.version !== "string") {
        return null;
      }
      return parsed as unknown as InstallStatusOk;
    }
    if (parsed.ok === false) {
      return parsed as unknown as InstallStatusFail;
    }
    return null;
  } catch {
    return null;
  }
}

export function getBinaryStatusFrom(root: string): BinaryStatus {
  const status = readInstallStatus(root);
  const binPath = path.join(root, "bin", "nono");
  const binaryPresent = isExecutable(binPath);

  if (status === null) {
    if (binaryPresent) {
      return {
        kind: "install-failed",
        reason: "marker-missing",
        detail: "Binary is present but install-status marker is missing (state drift).",
      };
    }
    return {
      kind: "install-failed",
      reason: "marker-missing",
      detail: "No install-status marker found.",
    };
  }

  if (!status.ok) {
    if (status.reason === "platform-unsupported") {
      return { kind: "platform-unsupported", platform: process.platform };
    }
    return { kind: "install-failed", reason: status.reason, detail: status.detail };
  }

  if (!binaryPresent) {
    return {
      kind: "install-failed",
      reason: "binary-missing-after-ok",
      detail: "Install marker reports success but binary is not present (state drift).",
    };
  }

  return { kind: "ok", path: binPath, version: status.version };
}

/**
 * Return the structured installation status of the nono binary.
 *
 * Reads `bin/.install-status.json` written by postinstall and cross-checks it
 * against the binary's actual presence on disk. Disagreements (marker says ok
 * but binary is absent, or vice versa) are surfaced as `install-failed` with a
 * synthetic reason so callers don't need to probe the filesystem themselves.
 */
export function getBinaryStatus(): BinaryStatus {
  return getBinaryStatusFrom(pkgRoot());
}

/**
 * Resolve the nono binary path. Returns the pkg-root binary when install
 * status is ok, falls back to `nono` on $PATH, or null for in-process-only mode.
 */
export function getNonoPath(): string | null {
  const status = getBinaryStatus();
  if (status.kind === "ok") return status.path;

  return whichInPath("nono", process.env.PATH ?? "");
}

export interface BinaryRuntime {
  getBinaryStatus: () => BinaryStatus;
  getNonoPath: () => string | null;
  warnMissingOnce: (notify: (msg: string, level: "warning" | "error") => void) => void;
}

export function createBinaryRuntime(): BinaryRuntime {
  let missingBinaryWarned = false;

  return {
    getBinaryStatus,
    getNonoPath,
    warnMissingOnce(notify) {
      if (missingBinaryWarned) return;
      missingBinaryWarned = true;
      notify(
        "pi-sandbox: nono binary not found — subprocess sandboxing is disabled. " +
          "In-process policy enforcement remains active.",
        "warning"
      );
    },
  };
}
