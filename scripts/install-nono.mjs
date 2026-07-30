import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { swapSync, unlock, waitForLockSync } from "fs-native-extensions";
import * as tar from "tar";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = JSON.parse(
  readFileSync(join(root, "src/extensions/guard/nono-assets.json"), "utf8"),
);

function reviewedAssets(value) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("reviewed Nono assets must contain exactly two entries");
  }
  const version = value[0]?.archive?.match(/^nono-v(\d+\.\d+\.\d+)-/)?.[1];
  if (
    !version ||
    new Set(value.map((asset) => asset.target)).size !== value.length ||
    value.some(
      (asset) =>
        typeof asset.target !== "string" ||
        typeof asset.platform !== "string" ||
        typeof asset.arch !== "string" ||
        typeof asset.archive !== "string" ||
        typeof asset.url !== "string" ||
        !/^[a-f0-9]{64}$/.test(asset.sha256 ?? "") ||
        !asset.archive.startsWith(`nono-v${version}-`) ||
        !asset.url.includes(`/v${version}/`),
    )
  ) {
    throw new Error("reviewed Nono asset metadata is invalid");
  }
  return { assets: value, version };
}

const reviewed = reviewedAssets(assets);

function targetForHost(platform = process.platform, arch = process.arch) {
  return (
    reviewed.assets.find(
      (asset) => asset.platform === platform && asset.arch === arch,
    )?.target ?? null
  );
}

function managedTarget(target, agentDir = getAgentDir()) {
  return join(agentDir, "pipkin", "guard", "nono", reviewed.version, target);
}

function runProbe(binary, directory) {
  const version = execFileSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (
    !new RegExp(
      `(?:^|\\s)v?${reviewed.version.replaceAll(".", "\\.")}(?:\\s|$)`,
    ).test(version)
  ) {
    throw new Error(
      `expected Nono ${reviewed.version}, got ${JSON.stringify(version)}`,
    );
  }
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
}

async function extractNono(archivePath, destination) {
  const files = [];
  await tar.t({
    file: archivePath,
    onReadEntry(entry) {
      if (
        entry.path !== "nono" ||
        entry.type !== "File" ||
        entry.path.includes("/") ||
        entry.path.includes("\\")
      ) {
        throw new Error(
          "archive must contain exactly one root regular file named nono",
        );
      }
      const chunks = [];
      entry.on("data", (chunk) => chunks.push(chunk));
      entry.on("end", () => files.push(Buffer.concat(chunks)));
    },
  });
  if (files.length !== 1) {
    throw new Error(
      "archive must contain exactly one root regular file named nono",
    );
  }
  writeFileSync(destination, files[0], { mode: 0o700 });
}

function validExistingTarget(targetDirectory, probe = runProbe) {
  const binary = join(targetDirectory, "pipkin-nono");
  try {
    accessSync(binary, 1);
    probe(binary, targetDirectory);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(lockPath) {
  const fd = openSync(lockPath, "a", 0o600);
  try {
    waitForLockSync(fd);
    return { fd };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function releaseLock(lock) {
  try {
    unlock(lock.fd);
  } finally {
    closeSync(lock.fd);
  }
}

export function activate(
  stagedTarget,
  targetDirectory,
  { swap = swapSync } = {},
) {
  if (existsSync(targetDirectory)) {
    swap(stagedTarget, targetDirectory);
    return;
  }
  renameSync(stagedTarget, targetDirectory);
}

export async function install(options = {}) {
  const target = options.target ?? targetForHost();
  if (target === null) {
    console.log("Pipkin Guard: managed Nono is unavailable on this host.");
    return;
  }
  if (process.env.PIPKIN_SKIP_NONO_DOWNLOAD) {
    return;
  }

  const asset =
    options.asset ??
    reviewed.assets.find((candidate) => candidate.target === target);
  if (!asset) {
    throw new Error(`no reviewed Nono asset for ${target}`);
  }
  const targetDirectory =
    options.targetDirectory ?? managedTarget(target, options.agentDir);
  const fetchImpl = options.fetch ?? fetch;
  const createStaging = options.createStaging ?? mkdtempSync;
  const extract = options.extract ?? extractNono;
  const probe = options.probe ?? runProbe;
  const activateTarget = options.activate ?? activate;
  const cleanupPath = options.cleanup ?? rmSync;
  const exit = options.exit ?? process.exit;

  mkdirSync(dirname(targetDirectory), { recursive: true, mode: 0o700 });
  const lock = acquireLock(`${targetDirectory}.install-lock`);
  let staging;
  let finished = false;
  let cleanupFailed = false;
  const cleanup = (path) => {
    if (!path) {
      return;
    }
    try {
      cleanupPath(path, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
  };
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    cleanup(staging);
    staging = undefined;
    try {
      releaseLock(lock);
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      console.warn(
        "Pipkin Guard: Nono installer cleanup could not be completed.",
      );
    }
  };
  const interrupted = () => {
    finish();
    exit(1);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    if (validExistingTarget(targetDirectory, probe)) {
      return;
    }
    staging = createStaging(join(tmpdir(), "pipkin-nono-install-"));
    const response = await fetchImpl(asset.url);
    if (!response.ok) {
      throw new Error(`download failed with HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) {
      throw new Error("download SHA-256 does not match the reviewed asset");
    }

    const archive = join(staging, asset.archive);
    const stagedTarget = join(staging, "target");
    mkdirSync(stagedTarget, { mode: 0o700 });
    writeFileSync(archive, bytes, { mode: 0o600 });
    const binary = join(stagedTarget, "pipkin-nono");
    await extract(archive, binary);
    chmodSync(binary, 0o755);
    probe(binary, stagedTarget);

    activateTarget(stagedTarget, targetDirectory);
    console.log(
      `Pipkin Guard: installed Nono ${reviewed.version} at ${join(targetDirectory, "pipkin-nono")}`,
    );
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    finish();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  install().catch((error) => {
    console.warn(`Pipkin Guard: Nono installation skipped: ${error.message}`);
  });
}
