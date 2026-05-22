// @ts-check
"use strict";

const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const pkgRoot = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
const NONO_VERSION = pkg.nonoVersion;
const NONO_SHA256SUMS_HASH = pkg.nonoSha256SumsHash;
const BIN_DIR = path.join(pkgRoot, "bin");
const BIN_PATH = path.join(BIN_DIR, "nono");
const STATUS_PATH = path.join(BIN_DIR, ".install-status.json");

function writeStatus(status) {
  try {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.writeFileSync(STATUS_PATH, JSON.stringify({ ...status, ts: Date.now() }), "utf8");
  } catch (err) {
    console.warn("pi-sandbox: could not write install-status marker:", err.message);
  }
}

if (process.env.PI_SANDBOX_SKIP_DOWNLOAD === "1") {
  console.log("pi-sandbox: PI_SANDBOX_SKIP_DOWNLOAD=1, skipping nono download.");
  writeStatus({ ok: false, reason: "download-skipped", detail: "PI_SANDBOX_SKIP_DOWNLOAD=1 was set." });
  process.exit(0);
}

function getPlatformTarget() {
  const { platform, arch } = process;

  if (platform === "darwin") {
    if (arch === "arm64") return { target: "nono-aarch64-apple-darwin", supported: true };
    if (arch === "x64") return { target: "nono-x86_64-apple-darwin", supported: true };
    return { target: null, supported: false };
  }

  if (platform === "linux") {
    const isMusl = isMuslLinux();
    if (isMusl) {
      return { target: null, supported: false, musl: true };
    }
    if (arch === "arm64") return { target: "nono-aarch64-unknown-linux-gnu", supported: true };
    if (arch === "x64") return { target: "nono-x86_64-unknown-linux-gnu", supported: true };
    return { target: null, supported: false };
  }

  return { target: null, supported: false };
}

function isMuslLinux() {
  try {
    const report = process.report && process.report.getReport();
    if (report && report.header) {
      return report.header.glibcVersionRuntime === undefined;
    }
  } catch {
    // ignore
  }
  return false;
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const request = (u) => {
      https.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }).on("error", reject);
    };
    request(url);
  });
}

function parseSha256Sums(content) {
  const map = new Map();
  for (const line of content.toString("utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) continue;
    const hash = trimmed.slice(0, spaceIdx).trim();
    const filename = trimmed.slice(spaceIdx).trim().replace(/^\*/, "");
    map.set(filename, hash);
  }
  return map;
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

async function main() {
  const { platform } = process;

  const result = getPlatformTarget();

  if (!result.supported) {
    const detail = result.musl
      ? "Linux musl (Alpine/distroless) detected — nono binary is not available for musl. " +
        "To install nono manually, see https://github.com/always-further/nono/releases."
      : `platform ${platform}/${process.arch} is not supported for nono binary download.`;

    if (result.musl) {
      console.log(
        "pi-sandbox: Linux musl (Alpine/distroless) detected — nono binary is not available for musl. " +
          "Sandbox will run in in-process-only mode. " +
          "To install nono manually, see https://github.com/always-further/nono/releases."
      );
    } else {
      console.log(
        `pi-sandbox: platform ${platform}/${process.arch} is not supported for nono binary download. ` +
          "Sandbox will run in in-process-only mode."
      );
    }

    writeStatus({ ok: false, reason: "platform-unsupported", detail });
    process.exit(0);
  }

  const { target } = result;
  const tarball = `${target}.tar.gz`;
  const baseUrl = `https://github.com/always-further/nono/releases/download/v${NONO_VERSION}`;
  const tarballUrl = `${baseUrl}/${tarball}`;
  const sha256Url = `${baseUrl}/SHA256SUMS.txt`;

  console.log(`pi-sandbox: downloading nono v${NONO_VERSION} for ${target}...`);

  let sha256Content;
  try {
    sha256Content = await httpsGet(sha256Url);
  } catch (err) {
    console.log(`pi-sandbox: could not fetch SHA256SUMS.txt (${err.message}). Skipping nono install.`);
    writeStatus({
      ok: false,
      reason: "sha256-fetch-failed",
      detail: `Could not fetch SHA256SUMS.txt: ${err.message}`,
    });
    process.exit(0);
  }

  if (NONO_SHA256SUMS_HASH) {
    const actualSumsHash = crypto.createHash("sha256").update(sha256Content).digest("hex");
    if (actualSumsHash !== NONO_SHA256SUMS_HASH) {
      console.error(
        `pi-sandbox: SHA256SUMS.txt hash mismatch!\n` +
          `  expected: ${NONO_SHA256SUMS_HASH}\n` +
          `  actual:   ${actualSumsHash}\n` +
          "Refusing to trust SHA256SUMS.txt entries. Skipping nono install."
      );
      writeStatus({
        ok: false,
        reason: "sha256sums-hash-mismatch",
        detail: `SHA256SUMS.txt hash mismatch: expected ${NONO_SHA256SUMS_HASH}, got ${actualSumsHash}`,
      });
      process.exit(0);
    }
  }

  const sha256Map = parseSha256Sums(sha256Content);

  const expectedHash = sha256Map.get(tarball);
  if (!expectedHash) {
    console.log(`pi-sandbox: no SHA256 entry found for ${tarball}. Skipping nono install.`);
    writeStatus({
      ok: false,
      reason: "sha256-fetch-failed",
      detail: `No SHA256 entry found for ${tarball} in SHA256SUMS.txt.`,
    });
    process.exit(0);
  }

  let tarballData;
  try {
    tarballData = await httpsGet(tarballUrl);
  } catch (err) {
    console.log(`pi-sandbox: could not fetch nono binary (${err.message}). Skipping nono install.`);
    writeStatus({
      ok: false,
      reason: "binary-fetch-failed",
      detail: `Could not fetch ${tarball}: ${err.message}`,
    });
    process.exit(0);
  }

  const actualHash = crypto.createHash("sha256").update(tarballData).digest("hex");
  if (actualHash !== expectedHash) {
    console.error(
      `pi-sandbox: SHA256 mismatch for ${tarball}!\n` +
        `  expected: ${expectedHash}\n` +
        `  actual:   ${actualHash}\n` +
        "Aborting install."
    );
    writeStatus({
      ok: false,
      reason: "sha256-mismatch",
      detail: `SHA256 mismatch for ${tarball}: expected ${expectedHash}, got ${actualHash}`,
    });
    process.exit(0);
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const tmpTar = path.join(os.tmpdir(), `pi-sandbox-nono-${Date.now()}.tar.gz`);
  const extractDir = path.join(os.tmpdir(), `pi-sandbox-nono-extract-${Date.now()}`);
  fs.writeFileSync(tmpTar, tarballData);
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    execFileSync("tar", ["-xzf", tmpTar, "-C", extractDir], { stdio: "pipe" });
  } catch (err) {
    console.log(`pi-sandbox: tar extraction failed (${err.message}). Skipping nono install.`);
    try { fs.unlinkSync(tmpTar); } catch { /* ignore */ }
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
    writeStatus({
      ok: false,
      reason: "binary-fetch-failed",
      detail: `tar extraction failed: ${err.message}`,
    });
    process.exit(0);
  } finally {
    try { fs.unlinkSync(tmpTar); } catch { /* ignore */ }
  }

  const foundBin = findFile(extractDir, "nono");
  if (!foundBin) {
    console.log("pi-sandbox: nono binary not found in tarball. Skipping nono install.");
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
    writeStatus({
      ok: false,
      reason: "binary-fetch-failed",
      detail: "nono binary not found in extracted tarball.",
    });
    process.exit(0);
  }

  fs.renameSync(foundBin, BIN_PATH);
  try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }

  if (!fs.existsSync(BIN_PATH)) {
    console.log("pi-sandbox: binary not found after extraction. Skipping nono install.");
    writeStatus({
      ok: false,
      reason: "binary-fetch-failed",
      detail: "Binary not found after extraction and rename.",
    });
    process.exit(0);
  }

  fs.chmodSync(BIN_PATH, 0o755);
  console.log(`pi-sandbox: nono v${NONO_VERSION} installed at ${BIN_PATH}`);
  writeStatus({ ok: true, version: NONO_VERSION });
}

main().catch((err) => {
  console.error("postinstall failed:", err.message);
  writeStatus({
    ok: false,
    reason: "binary-fetch-failed",
    detail: `Unexpected postinstall error: ${err.message}`,
  });
  process.exit(0);
});
