import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const _require = createRequire(import.meta.url);

export type BinaryStatus =
  | {
      kind: "ok";
      path: string;
      version: string;
      source: "override" | "cache" | "path";
    }
  | {
      kind: "platform-unsupported";
      platform: string;
    }
  | { kind: "install-failed"; reason: string; detail?: string };

export function pkgRoot(): string {
  return path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
}

export function pinnedVersion(): string {
  try {
    const pkg = _require(path.join(pkgRoot(), "package.json")) as {
      nonoVersion?: string;
    };
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
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function targetSegment(target: string): string {
  return target.replace(/^nono-/, "");
}

export function cacheDirForTarget(version: string, target: string): string {
  return path.join(
    getAgentDir(),
    "cache",
    "pi-sandbox",
    "nono",
    version,
    targetSegment(target),
  );
}

export function getPlatformTarget(): string | null {
  const { platform, arch } = process;

  if (platform === "darwin") {
    if (arch === "arm64") {
      return "nono-aarch64-apple-darwin";
    }
    if (arch === "x64") {
      return "nono-x86_64-apple-darwin";
    }
    return null;
  }

  if (platform === "linux") {
    if (detectMusl()) {
      return null;
    }
    if (arch === "arm64") {
      return "nono-aarch64-unknown-linux-gnu";
    }
    if (arch === "x64") {
      return "nono-x86_64-unknown-linux-gnu";
    }
    return null;
  }

  return null;
}

export function getNonoCacheDir(): string | null {
  const target = getPlatformTarget();
  if (target === null) {
    return null;
  }
  return cacheDirForTarget(pinnedVersion(), target);
}

export function resolveNonoPath(
  cacheDir: string | null,
  pathEnv: string,
  overridePath?: string,
): string | null {
  if (overridePath && isExecutable(overridePath)) {
    return overridePath;
  }

  if (cacheDir !== null) {
    const cachedBin = path.join(cacheDir, "nono");
    if (isExecutable(cachedBin)) {
      return cachedBin;
    }
  }

  const onPath = whichInPath("nono", pathEnv);
  if (onPath) {
    return onPath;
  }

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
  notify: (msg: string, level: "warning" | "error") => void,
): void {
  const actual = readNonoVersion(binPath);
  if (actual === null) {
    return;
  }

  const pinned = pinnedVersion();
  if (pinned === "unknown") {
    return;
  }

  const actualVersion = actual.replace(/^nono\s+v?/i, "").replace(/^v/, "");
  const pinnedVersion_ = pinned.replace(/^v/, "");

  if (actualVersion !== pinnedVersion_) {
    notify(
      `pi-sandbox: nono version mismatch — expected v${pinnedVersion_}, found "${actual}". ` +
        "This may cause compatibility issues. Continuing anyway.",
      "warning",
    );
  }
}

export type IsMuslResult = {
  isMusl: boolean;
};

/**
 * Detect whether we're running on a musl-based Linux system.
 * Uses process.report.getReport().header.glibcVersionRuntime: if undefined on Linux, assume musl.
 */
export function detectMusl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const report = process.report?.getReport() as
      | {
          header?: { glibcVersionRuntime?: string };
        }
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
  return getPlatformTarget() !== null;
}

type InstallStatusOk = {
  ok: true;
  version: string;
  ts: number;
};

type InstallStatusFail = {
  ok: false;
  reason: string;
  detail?: string;
  ts: number;
};

type InstallStatus = InstallStatusOk | InstallStatusFail;

function readInstallStatus(cacheDir: string): InstallStatus | null {
  const statusPath = path.join(cacheDir, ".install-status.json");
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

export function getBinaryStatusFrom(cacheDir: string): BinaryStatus {
  const status = readInstallStatus(cacheDir);
  const binPath = path.join(cacheDir, "nono");
  const binaryPresent = isExecutable(binPath);

  if (status === null) {
    if (binaryPresent) {
      return {
        kind: "install-failed",
        reason: "marker-missing",
        detail:
          "Binary is present but install-status marker is missing (state drift).",
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
    return {
      kind: "install-failed",
      reason: status.reason,
      detail: status.detail,
    };
  }

  if (!binaryPresent) {
    return {
      kind: "install-failed",
      reason: "binary-missing-after-ok",
      detail:
        "Install marker reports success but binary is not present (state drift).",
    };
  }

  return {
    kind: "ok",
    path: binPath,
    version: status.version,
    source: "cache",
  };
}

function statusForExternalBinary(
  binPath: string,
  source: "override" | "path",
): BinaryStatus {
  return {
    kind: "ok",
    path: binPath,
    version: readNonoVersion(binPath) ?? "unknown",
    source,
  };
}

/**
 * Return the structured runtime status of the nono binary.
 *
 * Checks the same resolution order as `getNonoPath`: explicit override, cached
 * install, then PATH fallback. Cache installs are cross-checked against their
 * marker so install drift is still reported when no external binary is usable.
 */
export function getBinaryStatus(): BinaryStatus {
  const overridePath = process.env.PI_SANDBOX_NONO_PATH;
  if (overridePath && isExecutable(overridePath)) {
    return statusForExternalBinary(overridePath, "override");
  }

  const cacheDir = getNonoCacheDir();
  if (cacheDir !== null) {
    const cacheStatus = getBinaryStatusFrom(cacheDir);
    if (cacheStatus.kind === "ok") {
      return cacheStatus;
    }

    const pathBin = whichInPath("nono", process.env.PATH ?? "");
    if (pathBin !== null) {
      return statusForExternalBinary(pathBin, "path");
    }

    return cacheStatus;
  }

  const pathBin = whichInPath("nono", process.env.PATH ?? "");
  if (pathBin !== null) {
    return statusForExternalBinary(pathBin, "path");
  }

  return { kind: "platform-unsupported", platform: process.platform };
}

/**
 * Resolve the nono binary path. Returns an explicit override when executable,
 * then the cached binary, then `nono` on $PATH, or null for in-process-only mode.
 */
export function getNonoPath(): string | null {
  const status = getBinaryStatus();
  return status.kind === "ok" ? status.path : null;
}

export type BinaryRuntime = {
  getBinaryStatus: () => BinaryStatus;
  getNonoPath: () => string | null;
  warnMissingOnce: (
    notify: (msg: string, level: "warning" | "error") => void,
  ) => void;
};

export function createBinaryRuntime(): BinaryRuntime {
  let missingBinaryWarned = false;

  return {
    getBinaryStatus,
    getNonoPath,
    warnMissingOnce(notify) {
      if (missingBinaryWarned) {
        return;
      }
      missingBinaryWarned = true;
      notify(
        "pi-sandbox: nono binary not found — subprocess sandboxing is disabled. " +
          "In-process policy enforcement remains active.",
        "warning",
      );
    },
  };
}
