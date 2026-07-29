import { execFileSync } from "node:child_process";
import { accessSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import assets from "../nono-assets.json";

type NonoAsset = Readonly<{
  target: string;
  platform: string;
  arch: string;
  archive: string;
  url: string;
  sha256: string;
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
export type NonoTarget = (typeof reviewed.assets)[number]["target"];
export type NonoHealth =
  | { kind: "healthy"; path: string; source: "override" | "managed" }
  | { kind: "platform-unsupported"; platform: string; arch: string }
  | { kind: "absent"; path: string; source: "override" | "managed" }
  | { kind: "non-executable"; path: string; source: "override" | "managed" }
  | {
      kind: "wrong-version-or-corrupt";
      path: string;
      source: "override" | "managed";
    }
  | { kind: "probe-failed"; path: string; source: "override" | "managed" };

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

function executable(path: string): boolean {
  try {
    accessSync(path, 1);
    return true;
  } catch {
    return false;
  }
}

function versionIsExact(binary: string): boolean {
  try {
    const version = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return new RegExp(
      `(?:^|\\s)v?${NONO_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`,
    ).test(version);
  } catch {
    return false;
  }
}

function acceptsMinimalManifest(binary: string): boolean {
  const directory = mkdtempSync(join(tmpdir(), "pipkin-nono-run-"));
  try {
    const manifest = join(directory, "pipkin-nono-manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({ version: "0.1.0", network: { mode: "unrestricted" } }),
      { mode: 0o600 },
    );
    execFileSync(binary, ["run", "--config", manifest, "--", "/usr/bin/true"], {
      timeout: 5_000,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function getNonoHealth(): NonoHealth {
  const target = getNonoTarget();
  if (target === null) {
    return {
      kind: "platform-unsupported",
      platform: process.platform,
      arch: process.arch,
    };
  }

  const override = process.env.PIPKIN_NONO_PATH;
  const source = override === undefined ? "managed" : "override";
  const binary =
    override === undefined ? managedNonoPath(target)! : resolve(override);
  try {
    accessSync(binary);
  } catch {
    return { kind: "absent", path: binary, source };
  }
  if (!executable(binary)) {
    return { kind: "non-executable", path: binary, source };
  }
  if (!versionIsExact(binary)) {
    return { kind: "wrong-version-or-corrupt", path: binary, source };
  }
  if (!acceptsMinimalManifest(binary)) {
    return { kind: "probe-failed", path: binary, source };
  }
  return { kind: "healthy", path: binary, source };
}

export function nonoRecoveryMessage(
  health: Exclude<NonoHealth, { kind: "healthy" }>,
): string {
  const detail =
    health.kind === "platform-unsupported"
      ? `Guard confinement is unavailable on ${health.platform}/${health.arch}.`
      : health.source === "override"
        ? `PIPKIN_NONO_PATH is ${health.kind.replaceAll("-", " ")} at ${health.path}.`
        : `Managed Nono is ${health.kind.replaceAll("-", " ")} at ${health.path}.`;
  const recovery =
    health.kind === "platform-unsupported"
      ? "Pi uses local execution on this platform."
      : health.source === "override"
        ? "Correct or unset PIPKIN_NONO_PATH, then reload or restart Pi."
        : "Run npm install (or npm run postinstall) from the Pipkin root, then reload or restart Pi.";
  return `${detail} ${recovery}`;
}
