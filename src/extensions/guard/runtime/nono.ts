import {
  accessSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { FixedCapabilities } from "../capabilities.js";
import {
  buildNonoManifest,
  runNono,
  runNonoCommand,
  type NonoRunResult,
  writeNonoManifest,
} from "./manifest.js";
import assets from "../nono-assets.json";

type NonoAsset = Readonly<{
  target: string;
  platform: string;
  arch: string;
  archive: string;
  url: string;
  sha256: string;
}>;

export type NonoHealth =
  | { kind: "healthy"; path: string }
  | {
      kind: "tools-only";
      reason:
        | "missing"
        | "non-executable"
        | "wrong-version-or-corrupt"
        | "manifest-rejected"
        | "probe-failed"
        | "timeout"
        | "cancelled"
        | "ineffective-confinement";
    };

export type NonoHealthProbeOptions = Readonly<{
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  signal?: AbortSignal;
  timeoutMs?: number;
  binaryPath?: string;
}>;

function reviewedAssets(value: unknown): {
  assets: readonly NonoAsset[];
  version: string;
} {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("reviewed Nono assets must contain exactly two entries");
  }
  const entries = value as NonoAsset[];
  const version = entries[0]?.archive.match(/^nono-v(\d+\.\d+\.\d+)-/)?.[1];
  if (
    !version ||
    new Set(entries.map((asset) => asset.target)).size !== entries.length ||
    entries.some(
      (asset) =>
        !asset.target ||
        !asset.platform ||
        !asset.arch ||
        !asset.archive.startsWith(`nono-v${version}-`) ||
        !asset.url.includes(`/v${version}/`) ||
        !/^[a-f0-9]{64}$/.test(asset.sha256),
    )
  ) {
    throw new Error("reviewed Nono asset metadata is invalid");
  }
  return { assets: entries, version };
}

const reviewed = reviewedAssets(assets);
export const NONO_VERSION = reviewed.version;
const PROBE_TIMEOUT_MS = 5_000;
export type NonoTarget = (typeof reviewed.assets)[number]["target"];

export function getNonoTarget(
  platform = process.platform,
  arch = process.arch,
): NonoTarget | null {
  return (
    reviewed.assets.find(
      (asset) => asset.platform === platform && asset.arch === arch,
    )?.target ?? null
  );
}

export function managedNonoPath(target = getNonoTarget()): string | null {
  return target === null
    ? null
    : join(
        getAgentDir(),
        "pipkin",
        "guard",
        "nono",
        NONO_VERSION,
        target,
        "pipkin-nono",
      );
}

function exists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, 1);
    return true;
  } catch {
    return false;
  }
}

function exactVersion(result: NonoRunResult): boolean {
  return (
    result.kind === "exited" &&
    result.exitCode === 0 &&
    new RegExp(
      `(?:^|\\s)(?:nono\\s+)?v?${NONO_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`,
    ).test(result.stdout)
  );
}

function probeFixedCapabilities(inside: string): FixedCapabilities {
  return {
    cwd: inside,
    grants: [
      { path: inside, access: "read", kind: "directory", effects: [] },
      { path: inside, access: "write", kind: "directory", effects: [] },
      { path: "/bin", access: "read", kind: "directory", effects: [] },
      { path: "/usr", access: "read", kind: "directory", effects: [] },
    ],
  };
}

function deniedFilesystemAccess(result: NonoRunResult): boolean {
  return (
    result.kind === "exited" &&
    result.exitCode === 1 &&
    /operation not permitted|permission denied/i.test(result.stderr)
  );
}

function probeResult(result: NonoRunResult): NonoHealth | undefined {
  if (result.kind === "timeout") {
    return { kind: "tools-only", reason: "timeout" };
  }
  if (result.kind === "cancelled") {
    return { kind: "tools-only", reason: "cancelled" };
  }
  if (result.kind === "spawn-error") {
    return { kind: "tools-only", reason: "probe-failed" };
  }
  return undefined;
}

async function executeManifestProbe(
  binary: string,
  fixed: FixedCapabilities,
  target: string,
  options: Pick<NonoHealthProbeOptions, "signal" | "timeoutMs">,
): Promise<NonoRunResult> {
  const manifest = writeNonoManifest(buildNonoManifest(fixed, []));
  return runNono(binary, manifest, "/bin/cat", [target], options);
}

export async function getNonoHealth(
  options: NonoHealthProbeOptions = {},
): Promise<NonoHealth | undefined> {
  const target = getNonoTarget(options.platform, options.arch);
  if (target === null) {
    return undefined;
  }

  const binary = options.binaryPath ?? managedNonoPath(target)!;
  if (!exists(binary)) {
    return { kind: "tools-only", reason: "missing" };
  }
  if (!executable(binary)) {
    return { kind: "tools-only", reason: "non-executable" };
  }

  const probeOptions = {
    ...options,
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
  };
  const version = await runNonoCommand(binary, ["--version"], probeOptions);
  if (version.kind === "timeout") {
    return { kind: "tools-only", reason: "timeout" };
  }
  if (version.kind === "cancelled") {
    return { kind: "tools-only", reason: "cancelled" };
  }
  if (!exactVersion(version)) {
    return { kind: "tools-only", reason: "wrong-version-or-corrupt" };
  }

  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "pipkin-nono-health-"));
    const inside = join(directory, "inside");
    const insideFile = join(inside, "allowed");
    const outside = join(directory, "outside");
    mkdirSync(inside);
    writeFileSync(insideFile, "inside", { mode: 0o600 });
    writeFileSync(outside, "outside", { mode: 0o600 });
    const fixed = probeFixedCapabilities(inside);

    const insideResult = await executeManifestProbe(
      binary,
      fixed,
      insideFile,
      probeOptions,
    );
    const insideFailure = probeResult(insideResult);
    if (insideFailure) {
      return insideFailure;
    }
    if (insideResult.kind !== "exited" || insideResult.exitCode !== 0) {
      return { kind: "tools-only", reason: "manifest-rejected" };
    }

    const outsideResult = await executeManifestProbe(
      binary,
      fixed,
      outside,
      probeOptions,
    );
    const outsideFailure = probeResult(outsideResult);
    if (outsideFailure) {
      return outsideFailure;
    }
    if (!deniedFilesystemAccess(outsideResult)) {
      return {
        kind: "tools-only",
        reason:
          outsideResult.kind === "exited" && outsideResult.exitCode === 0
            ? "ineffective-confinement"
            : "probe-failed",
      };
    }
    return { kind: "healthy", path: binary };
  } catch {
    return { kind: "tools-only", reason: "probe-failed" };
  } finally {
    if (directory !== undefined) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {}
    }
  }
}

export function nonoRecoveryMessage(
  health: Extract<NonoHealth, { kind: "tools-only" }>,
): string {
  const detail = {
    missing: "Managed Nono is missing.",
    "non-executable": "Managed Nono is not executable.",
    "wrong-version-or-corrupt": `Managed Nono ${NONO_VERSION} is required.`,
    "manifest-rejected": "Managed Nono rejected Guard's manifest.",
    "probe-failed": "Managed Nono's confinement probe failed.",
    timeout: "Managed Nono's confinement probe timed out.",
    cancelled: "Managed Nono's confinement probe was cancelled.",
    "ineffective-confinement":
      "Managed Nono did not confine filesystem access.",
  }[health.reason];
  return `${detail} Run npm install (or npm run postinstall) from the Pipkin root, then reload or restart Pi.`;
}
