import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNono, writeNonoManifest } from "./manifest.js";
import { getNonoHealth, nonoRecoveryMessage } from "./nono.js";

const directories: string[] = [];
const environment = {
  PIPKIN_NONO_PATH: process.env.PIPKIN_NONO_PATH,
  PIPKIN_TEST_NONO_MODE: process.env.PIPKIN_TEST_NONO_MODE,
  PIPKIN_TEST_NONO_LOG: process.env.PIPKIN_TEST_NONO_LOG,
  PIPKIN_TEST_NONO_PIDS: process.env.PIPKIN_TEST_NONO_PIDS,
};

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "pipkin-nono-test-"));
  directories.push(directory);
  return directory;
}

function fakeNono(): { binary: string; log: string } {
  const root = fixture();
  const binary = join(root, "pipkin-nono");
  const log = join(root, "manifests");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const mode = process.env.PIPKIN_TEST_NONO_MODE;
if (args[0] === "--version") {
  process.stdout.write(mode === "wrong-version" ? "nono 0.68.0\\n" : "nono 0.69.0\\n");
  process.exit(0);
}
const config = args[args.indexOf("--config") + 1];
if (process.env.PIPKIN_TEST_NONO_LOG) appendFileSync(process.env.PIPKIN_TEST_NONO_LOG, config + "\\n");
const manifest = JSON.parse(readFileSync(config, "utf8"));
if (JSON.stringify(manifest.network) !== JSON.stringify({ mode: "unrestricted" })) process.exit(9);
if (mode === "manifest-rejected") process.exit(1);
if (mode === "hang") {
  setInterval(() => undefined, 1_000);
} else if (mode === "descendant") {
  process.on("SIGTERM", () => undefined);
  const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1_000)"], { stdio: "ignore" });
  writeFileSync(process.env.PIPKIN_TEST_NONO_PIDS, JSON.stringify([process.pid, descendant.pid]));
  setInterval(() => undefined, 1_000);
} else {
  const target = args.at(-1);
  if (target.endsWith("outside")) {
    if (mode === "ineffective") process.exit(0);
    if (mode === "probe-failed") process.exit(2);
    process.stderr.write("Operation not permitted\\n");
    process.exit(1);
  }
  process.exit(0);
}
`,
    { mode: 0o700 },
  );
  return { binary, log };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for Nono fixture");
}

async function health(mode: string) {
  const nono = fakeNono();
  process.env.PIPKIN_NONO_PATH = nono.binary;
  process.env.PIPKIN_TEST_NONO_MODE = mode;
  process.env.PIPKIN_TEST_NONO_LOG = nono.log;
  const result = await getNonoHealth({
    platform: "darwin",
    arch: "arm64",
    timeoutMs: 1_500,
  });
  return { nono, result };
}

describe("Nono backend health", () => {
  it("requires an unrestricted manifest to allow its fixed root and deny an outside file", async () => {
    const { nono, result } = await health("secure");

    expect(result).toMatchObject({ kind: "healthy", path: nono.binary });
    const manifests = readFileSync(nono.log, "utf8").trim().split("\n");
    expect(manifests).toHaveLength(2);
    expect(manifests.every((path) => !existsSync(path))).toBe(true);
  });

  it("classifies bounded executable and confinement failures as tools-only", async () => {
    const missing = join(fixture(), "missing");
    process.env.PIPKIN_NONO_PATH = missing;
    await expect(
      getNonoHealth({ platform: "darwin", arch: "arm64" }),
    ).resolves.toEqual({ kind: "tools-only", reason: "missing" });

    const nonExecutable = join(fixture(), "not-executable");
    writeFileSync(nonExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    chmodSync(nonExecutable, 0o600);
    process.env.PIPKIN_NONO_PATH = nonExecutable;
    await expect(
      getNonoHealth({ platform: "darwin", arch: "arm64" }),
    ).resolves.toEqual({ kind: "tools-only", reason: "non-executable" });

    await expect(
      health("wrong-version").then(({ result }) => result),
    ).resolves.toEqual({
      kind: "tools-only",
      reason: "wrong-version-or-corrupt",
    });
    await expect(
      health("manifest-rejected").then(({ result }) => result),
    ).resolves.toEqual({ kind: "tools-only", reason: "manifest-rejected" });
    await expect(
      health("probe-failed").then(({ result }) => result),
    ).resolves.toEqual({
      kind: "tools-only",
      reason: "probe-failed",
    });
    await expect(
      health("ineffective").then(({ result }) => result),
    ).resolves.toEqual({
      kind: "tools-only",
      reason: "ineffective-confinement",
    });
  });

  it("bounds cancellation and timeout while removing every staged manifest", async () => {
    const { nono, result } = await health("hang");
    expect(result).toEqual({ kind: "tools-only", reason: "timeout" });
    expect(
      readFileSync(nono.log, "utf8")
        .trim()
        .split("\n")
        .every((path) => !existsSync(path)),
    ).toBe(true);

    const controller = new AbortController();
    controller.abort();
    process.env.PIPKIN_NONO_PATH = nono.binary;
    await expect(
      getNonoHealth({
        platform: "darwin",
        arch: "arm64",
        signal: controller.signal,
      }),
    ).resolves.toEqual({ kind: "tools-only", reason: "cancelled" });

    const manifest = writeNonoManifest({
      version: "0.1.0",
      filesystem: { grants: [] },
      network: { mode: "unrestricted" },
    });
    const runController = new AbortController();
    const run = runNono(nono.binary, manifest, "/bin/cat", ["outside"], {
      signal: runController.signal,
    });
    runController.abort();
    await expect(run).resolves.toEqual({ kind: "cancelled" });
    expect(existsSync(manifest.path)).toBe(false);

    process.env.PIPKIN_TEST_NONO_MODE = "descendant";
    const timeoutPids = join(fixture(), "timeout-pids");
    process.env.PIPKIN_TEST_NONO_PIDS = timeoutPids;
    const timeoutManifest = writeNonoManifest({
      version: "0.1.0",
      filesystem: { grants: [] },
      network: { mode: "unrestricted" },
    });
    const timeoutRun = runNono(
      nono.binary,
      timeoutManifest,
      "/bin/cat",
      ["outside"],
      { timeoutMs: 1_000 },
    );
    await waitFor(() => existsSync(timeoutPids));
    await expect(timeoutRun).resolves.toEqual({ kind: "timeout" });
    expect(existsSync(timeoutManifest.path)).toBe(false);
    expect(
      JSON.parse(readFileSync(timeoutPids, "utf8")).every(
        (pid: number) => !isRunning(pid),
      ),
    ).toBe(true);

    const abortPids = join(fixture(), "abort-pids");
    process.env.PIPKIN_TEST_NONO_PIDS = abortPids;
    const abortManifest = writeNonoManifest({
      version: "0.1.0",
      filesystem: { grants: [] },
      network: { mode: "unrestricted" },
    });
    const descendantController = new AbortController();
    const descendantRun = runNono(
      nono.binary,
      abortManifest,
      "/bin/cat",
      ["outside"],
      { signal: descendantController.signal },
    );
    await waitFor(() => existsSync(abortPids));
    descendantController.abort();
    await expect(descendantRun).resolves.toEqual({ kind: "cancelled" });
    expect(existsSync(abortManifest.path)).toBe(false);
    expect(
      JSON.parse(readFileSync(abortPids, "utf8")).every(
        (pid: number) => !isRunning(pid),
      ),
    ).toBe(true);
  });

  it("does not classify unsupported hosts and keeps recovery bounded", async () => {
    const nono = fakeNono();
    process.env.PIPKIN_NONO_PATH = nono.binary;
    await expect(
      getNonoHealth({ platform: "linux", arch: "x64" }),
    ).resolves.toBeUndefined();
    expect(
      nonoRecoveryMessage({
        kind: "tools-only",
        reason: "ineffective-confinement",
      }),
    ).toBe(
      "Managed Nono did not confine filesystem access. Run npm install (or npm run postinstall) from the Pipkin root, then reload or restart Pi.",
    );
  });
});
