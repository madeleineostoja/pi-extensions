import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = JSON.parse(
  readFileSync(join(root, "src/extensions/guard/nono-assets.json"), "utf8"),
);
const version = assets[0]?.archive.match(/^nono-v(\d+\.\d+\.\d+)-/)?.[1];
if (!version) {
  throw new Error("could not determine the reviewed Nono version");
}

function hasExpectedVersion(binary) {
  try {
    accessSync(binary, 1);
    const output = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return new RegExp(
      `(?:^|\\s)v?${version.replaceAll(".", "\\.")}(?:\\s|$)`,
    ).test(output);
  } catch {
    return false;
  }
}

async function install() {
  const asset = assets.find(
    (candidate) =>
      candidate.platform === process.platform &&
      candidate.arch === process.arch,
  );
  if (!asset) {
    console.log("Pipkin Guard: managed Nono is unavailable on this host.");
    return;
  }
  if (process.env.PIPKIN_SKIP_NONO_DOWNLOAD) {
    return;
  }

  const agentDir =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const targetDirectory = join(
    agentDir,
    "pipkin",
    "guard",
    "nono",
    version,
    asset.target,
  );
  const binary = join(targetDirectory, "pipkin-nono");
  if (hasExpectedVersion(binary)) {
    return;
  }

  const parent = dirname(targetDirectory);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(parent, ".install-"));

  try {
    const response = await fetch(asset.url);
    if (!response.ok) {
      throw new Error(`download failed with HTTP ${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) {
      throw new Error("download SHA-256 does not match the reviewed asset");
    }

    const archive = join(staging, "nono.tar.gz");
    const extracted = join(staging, "target");
    writeFileSync(archive, bytes, { mode: 0o600 });
    mkdirSync(extracted, { mode: 0o700 });
    await tar.x({
      file: archive,
      cwd: extracted,
      strict: true,
      filter: (path, entry) => path === "nono" && entry.type === "File",
    });

    const stagedBinary = join(extracted, "nono");
    chmodSync(stagedBinary, 0o755);
    if (!hasExpectedVersion(stagedBinary)) {
      throw new Error(`downloaded executable is not Nono ${version}`);
    }
    renameSync(stagedBinary, join(extracted, "pipkin-nono"));

    rmSync(targetDirectory, { recursive: true, force: true });
    renameSync(extracted, targetDirectory);
    console.log(`Pipkin Guard: installed Nono ${version} at ${binary}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
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
