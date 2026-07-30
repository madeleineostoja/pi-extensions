import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activate, install } from "./install-nono.mjs";

const fixtures = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pipkin-nono-installer-test-"));
  fixtures.push(root);
  const bytes = Buffer.from("reviewed fixture archive");
  return {
    root,
    targetDirectory: join(root, "managed"),
    options: {
      target: "fixture",
      asset: {
        url: "https://example.test/nono.tar.gz",
        archive: "nono.tar.gz",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      createStaging: () => mkdtempSync(join(root, "pipkin-nono-install-")),
      extract: async (_archive, binary) => writeFileSync(binary, "complete"),
      probe: () => {},
      fetch: async () => ({
        ok: true,
        arrayBuffer: async () => bytes,
      }),
    },
  };
}

function stagingDirectories(root) {
  return readdirSync(root).filter((entry) =>
    entry.startsWith("pipkin-nono-install-"),
  );
}

function waitForActivation(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (data) => {
      if (data.toString() === "active\n") {
        resolvePromise();
      } else {
        reject(new Error(`unexpected lock worker output: ${data}`));
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`lock worker exited with ${code}`));
      }
    });
  });
}

function lockWorker(lockPath) {
  const installer = pathToFileURL(
    join(fileURLToPath(new URL(".", import.meta.url)), "install-nono.mjs"),
  ).href;
  const source = `
    import { acquireLock, releaseLock } from ${JSON.stringify(installer)};
    const lock = acquireLock(process.env.LOCK_PATH);
    process.stdout.write("active\\n");
    process.stdin.resume();
    process.stdin.once("data", () => {
      releaseLock(lock);
      process.exit(0);
    });
  `;
  return spawn(process.execPath, ["--input-type=module", "--eval", source], {
    env: { ...process.env, LOCK_PATH: lockPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

afterEach(() => {
  while (fixtures.length) {
    rmSync(fixtures.pop(), { recursive: true, force: true });
  }
});

describe("managed Nono installer", () => {
  it("removes its complete staging root after successful and failed installs", async () => {
    const successful = fixture();
    await install({
      ...successful.options,
      targetDirectory: successful.targetDirectory,
    });
    expect(stagingDirectories(successful.root)).toEqual([]);
    expect(existsSync(join(successful.targetDirectory, "pipkin-nono"))).toBe(
      true,
    );

    const failed = fixture();
    await expect(
      install({
        ...failed.options,
        targetDirectory: failed.targetDirectory,
        fetch: async () => ({ ok: false, status: 503 }),
      }),
    ).rejects.toThrow("download failed with HTTP 503");
    expect(stagingDirectories(failed.root)).toEqual([]);
  });

  it("cleans staging when interrupted and reports a cleanup failure once", async () => {
    const interrupted = fixture();
    const exit = vi.fn();
    await expect(
      install({
        ...interrupted.options,
        targetDirectory: interrupted.targetDirectory,
        exit,
        fetch: async () => {
          process.emit("SIGINT");
          throw new Error("interrupted download");
        },
      }),
    ).rejects.toThrow("interrupted download");
    expect(exit).toHaveBeenCalledWith(1);
    expect(stagingDirectories(interrupted.root)).toEqual([]);

    const cleanupFailure = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      install({
        ...cleanupFailure.options,
        targetDirectory: cleanupFailure.targetDirectory,
        cleanup: () => {
          throw new Error("cleanup failure");
        },
      }),
    ).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      "Pipkin Guard: Nono installer cleanup could not be completed.",
    );
    warning.mockRestore();
  });

  it("uses a kernel lock so only one installer enters activation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-nono-lock-test-"));
    fixtures.push(root);
    const lockPath = join(root, "managed.install-lock");
    const first = lockWorker(lockPath);
    await waitForActivation(first);

    const second = lockWorker(lockPath);
    let secondActivated = false;
    const secondReady = waitForActivation(second).then(() => {
      secondActivated = true;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    expect(secondActivated).toBe(false);

    const firstExit = waitForExit(first);
    first.stdin.write("release\n");
    await firstExit;
    await secondReady;
    expect(existsSync(lockPath)).toBe(true);

    const secondExit = waitForExit(second);
    second.stdin.write("release\n");
    await secondExit;
  });

  it("never exposes a half-written executable during atomic activation", () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-nono-activation-test-"));
    fixtures.push(root);
    const target = join(root, "target");
    const staged = join(root, "staged");
    mkdirSync(target);
    mkdirSync(staged);
    writeFileSync(join(target, "pipkin-nono"), "previous executable");
    writeFileSync(join(staged, "pipkin-nono"), "new executable");

    activate(staged, target);

    expect(readFileSync(join(target, "pipkin-nono"), "utf8")).toBe(
      "new executable",
    );
    expect(readFileSync(join(staged, "pipkin-nono"), "utf8")).toBe(
      "previous executable",
    );
  });

  it("keeps the completed executable when final activation fails", () => {
    const root = mkdtempSync(join(tmpdir(), "pipkin-nono-activation-test-"));
    fixtures.push(root);
    const target = join(root, "target");
    const staged = join(root, "staged");
    mkdirSync(target);
    mkdirSync(staged);
    writeFileSync(join(target, "pipkin-nono"), "previous executable");
    writeFileSync(join(staged, "pipkin-nono"), "new executable");

    expect(() =>
      activate(staged, target, {
        swap: () => {
          throw new Error("injected final activation failure");
        },
      }),
    ).toThrow("injected final activation failure");
    expect(readFileSync(join(target, "pipkin-nono"), "utf8")).toBe(
      "previous executable",
    );
    expect(readFileSync(join(staged, "pipkin-nono"), "utf8")).toBe(
      "new executable",
    );
  });
});
