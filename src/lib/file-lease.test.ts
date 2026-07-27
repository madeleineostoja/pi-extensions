import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireFileLease,
  FileLeaseAbortedError,
  FileLeaseTimeoutError,
  probeFileLease,
  setFileLeaseTestHooks,
  tryAcquireFileLease,
} from "./file-lease.js";
const nodeRequire = createRequire(import.meta.url);
const roots: string[] = [];
const children: ChildProcess[] = [];
const workerPath = fileURLToPath(
  new URL("./file-lease-worker.cjs", import.meta.url),
);

function anchor(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-file-lease-"));
  roots.push(root);
  return join(root, "anchor.lock");
}

async function startLockHolder(anchorPath: string): Promise<{
  child: ChildProcess;
  status: "acquired" | "contended";
}> {
  const child = spawn(process.execPath, [workerPath, anchorPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const status = await new Promise<"acquired" | "contended">(
    (resolve, reject) => {
      let output = "";
      const timeout = setTimeout(
        () =>
          reject(
            new Error(`Lock worker did not report a status for ${anchorPath}.`),
          ),
        2_000,
      );
      child.once("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf-8");
        const line = output.trim();
        if (line === "acquired" || line === "contended") {
          clearTimeout(timeout);
          resolve(line);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        reject(new Error(`Lock worker failed: ${chunk.toString("utf-8")}`));
      });
    },
  );
  return { child, status };
}

async function stop(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill(signal);
  await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Lock worker did not exit.")), 2_000),
    ),
  ]);
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stop(child)));
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("file leases", () => {
  it("keeps unrelated shared exports usable when the native addon cannot load", async () => {
    const moduleLoader = nodeRequire(
      "node:module",
    ) as typeof import("node:module") & {
      _load(request: string, parent: unknown, isMain: boolean): unknown;
    };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (request, parent, isMain) {
      if (request === "fs-native-extensions") {
        throw new Error("native addon unavailable");
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    vi.resetModules();

    try {
      const library = await import("./file-lease.js");
      expect(typeof library.FileLeaseUnavailableError).toBe("function");
      await expect(library.tryAcquireFileLease(anchor())).rejects.toThrow(
        "cannot run unlocked",
      );
    } finally {
      moduleLoader._load = originalLoad;
      vi.resetModules();
    }
  });

  it("allows exactly one simultaneous immediate contender and keeps the anchor", async () => {
    const anchorPath = anchor();
    const [first, second] = await Promise.all([
      startLockHolder(anchorPath),
      startLockHolder(anchorPath),
    ]);

    expect(
      [first.status, second.status].filter((status) => status === "acquired"),
    ).toHaveLength(1);
    expect(statSync(anchorPath).isFile()).toBe(true);
  });

  it("releases on normal release and after owner death without replacing the anchor", async () => {
    const anchorPath = anchor();
    writeFileSync(anchorPath, "persistent anchor\n");
    const lease = await tryAcquireFileLease(anchorPath);
    expect(lease).toBeDefined();
    const inode = statSync(anchorPath).ino;

    await lease!.release();
    expect(statSync(anchorPath).ino).toBe(inode);
    expect(readFileSync(anchorPath, "utf-8")).toBe("persistent anchor\n");

    const owner = await startLockHolder(anchorPath);
    expect(owner.status).toBe("acquired");
    await stop(owner.child, "SIGKILL");

    const successor = await acquireFileLease(anchorPath, { timeoutMs: 500 });
    expect(statSync(anchorPath).ino).toBe(inode);
    await successor.release();
  });

  it("bounds timeout and abort while a different process owns the lease", async () => {
    const anchorPath = anchor();
    const owner = await startLockHolder(anchorPath);
    expect(owner.status).toBe("acquired");

    const startedAt = Date.now();
    await expect(
      acquireFileLease(anchorPath, { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(FileLeaseTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(500);

    const controller = new AbortController();
    const pending = acquireFileLease(anchorPath, {
      timeoutMs: 2_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort("test abort"), 25);
    await expect(pending).rejects.toBeInstanceOf(FileLeaseAbortedError);

    await stop(owner.child);
    const successor = await acquireFileLease(anchorPath, { timeoutMs: 500 });
    await successor.release();
  });

  it("closes every contended descriptor and aborts promptly", async () => {
    const controller = new AbortController();
    let opened = 0;
    let closed = 0;
    setFileLeaseTestHooks({
      addon: { tryLock: () => false, unlock: () => {} },
      openAnchor: async () => {
        opened++;
        return {
          fd: opened,
          close: async () => {
            closed++;
          },
        } as never;
      },
    });

    try {
      const startedAt = performance.now();
      const pending = acquireFileLease("test-anchor", {
        timeoutMs: 2_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort("test abort"), 10);
      await expect(pending).rejects.toBeInstanceOf(FileLeaseAbortedError);
      expect(performance.now() - startedAt).toBeLessThan(100);
    } finally {
      setFileLeaseTestHooks(undefined);
    }

    expect(opened).toBeGreaterThan(0);
    expect(closed).toBe(opened);
  });

  it("releases an acquired lease when abort wins the race", async () => {
    const controller = new AbortController();
    let unlockCalls = 0;
    let closeCalls = 0;
    setFileLeaseTestHooks({
      addon: {
        tryLock: () => true,
        unlock: () => {
          unlockCalls++;
        },
      },
      openAnchor: async () => {
        controller.abort("test abort");
        return {
          fd: 1,
          close: async () => {
            closeCalls++;
          },
        } as never;
      },
    });

    try {
      await expect(
        acquireFileLease("test-anchor", {
          timeoutMs: 2_000,
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(FileLeaseAbortedError);
    } finally {
      setFileLeaseTestHooks(undefined);
    }

    expect(unlockCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });

  it("makes release idempotent without releasing a successor", async () => {
    const anchorPath = anchor();
    const first = await acquireFileLease(anchorPath, { timeoutMs: 100 });
    await first.release();

    const successor = await acquireFileLease(anchorPath, { timeoutMs: 100 });
    await first.release();
    const contender = await startLockHolder(anchorPath);
    expect(contender.status).toBe("contended");
    await successor.release();
  });

  it("closes the descriptor when unlock fails", async () => {
    const unlockError = new Error("unlock failed");
    let closeCalls = 0;
    setFileLeaseTestHooks({
      addon: {
        tryLock: () => true,
        unlock: () => {
          throw unlockError;
        },
      },
      openAnchor: async () =>
        ({
          fd: 1,
          close: async () => {
            closeCalls++;
          },
        }) as never,
    });

    try {
      const lease = await tryAcquireFileLease("test-anchor");
      await expect(lease!.release()).rejects.toBe(unlockError);
    } finally {
      setFileLeaseTestHooks(undefined);
    }

    expect(closeCalls).toBe(1);
  });

  it("preserves unlock and close failures", async () => {
    const unlockError = new Error("unlock failed");
    const closeError = new Error("close failed");
    setFileLeaseTestHooks({
      addon: {
        tryLock: () => true,
        unlock: () => {
          throw unlockError;
        },
      },
      openAnchor: async () =>
        ({
          fd: 1,
          close: async () => {
            throw closeError;
          },
        }) as never,
    });

    try {
      const lease = await tryAcquireFileLease("test-anchor");
      await expect(lease!.release()).rejects.toSatisfy((error: unknown) => {
        return (
          error instanceof AggregateError &&
          error.errors.includes(unlockError) &&
          error.errors.includes(closeError)
        );
      });
    } finally {
      setFileLeaseTestHooks(undefined);
    }
  });

  it("probes held and free state without releasing another owner", async () => {
    const anchorPath = anchor();
    const owner = await startLockHolder(anchorPath);
    expect(owner.status).toBe("acquired");

    expect(await probeFileLease(anchorPath)).toBe("held");
    expect(await tryAcquireFileLease(anchorPath)).toBeUndefined();

    await stop(owner.child);
    expect(await probeFileLease(anchorPath)).toBe("free");
  });
});
