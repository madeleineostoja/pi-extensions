import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentLengthDecoder, encodeMessage } from "./protocol.js";
import {
  getLspPool,
  LspPool,
  LSP_POOL_MANAGER_KEY,
  type PoolAcquireResult,
} from "./pool.js";
import type { ResolvedServer } from "./server.js";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "pipkin-lsp-pool-"));
  directories.push(directory);
  return directory;
}
function server(): ResolvedServer {
  return {
    kind: "typescript",
    command: process.execPath,
    args: [],
    executableIdentity: "fake-server",
  };
}
function respondToInitialize(child: FakeChild, delayMs = 0): void {
  child.stdin.on("data", (frame: Buffer) => {
    const message = new ContentLengthDecoder().push(frame)[0];
    if (message.method === "initialize") {
      setTimeout(() => {
        child.stdout.write(
          encodeMessage({ id: message.id, result: { capabilities: {} } }),
        );
      }, delayMs);
    }
  });
}
function isClient(value: PoolAcquireResult): boolean {
  return !("available" in value && value.available === false);
}

describe("LspPool", () => {
  it("shares a concurrent cold start and canonicalizes workspace keys", async () => {
    const child = new FakeChild();
    respondToInitialize(child);
    const spawn = vi.fn(() => child) as never;
    const pool = new LspPool({ spawn });
    const root = workspace();
    const [first, second] = await Promise.all([
      pool.acquire(server(), root),
      pool.acquire(server(), resolve(root, ".")),
    ]);
    expect(isClient(first)).toBe(true);
    expect(first).toBe(second);
    expect(spawn).toHaveBeenCalledTimes(1);
    await pool.shutdown();
  });

  it("reserves process capacity while initialization is in flight", async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    let starts = 0;
    const spawn = vi.fn(() => (++starts === 1 ? first : second)) as never;
    const pool = new LspPool({ spawn, maxProcesses: 1 });
    const firstStart = pool.acquire(server(), workspace());
    const blocked = await pool.acquire(server(), workspace());
    expect(isClient(blocked)).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    first.emit("exit", 1, null);
    expect(isClient(await firstStart)).toBe(false);
    await pool.shutdown();
  });

  it("keeps a shared cold start alive when another caller times out or aborts", async () => {
    const child = new FakeChild();
    respondToInitialize(child, 50);
    const spawn = vi.fn(() => child) as never;
    const pool = new LspPool({ spawn, initializeTimeoutMs: 1_000 });
    const root = workspace();
    const controller = new AbortController();
    const timedOut = pool.acquire(server(), root, { timeoutMs: 5 });
    const aborted = pool.acquire(server(), root, { signal: controller.signal });
    const survivor = pool.acquire(server(), root);
    await vi.waitFor(() => expect(pool.status()[0]?.starting).toBe(true));
    controller.abort();

    await expect(aborted).rejects.toThrow("cancelled");
    await expect(timedOut).resolves.toMatchObject({
      available: false,
      reason: expect.stringMatching(/timed out/),
    });
    expect(isClient(await survivor)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    await pool.shutdown();
  });

  it("does not start a queued acquisition after its caller timed out", async () => {
    const first = new FakeChild();
    respondToInitialize(first);
    let shutdownId: number | string | null | undefined;
    first.stdin.on("data", (frame: Buffer) => {
      const message = new ContentLengthDecoder().push(frame)[0];
      if (message.method === "shutdown") {
        shutdownId = message.id;
      }
    });
    const spawn = vi.fn(() => first) as never;
    let now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const pool = new LspPool({ spawn, maxProcesses: 1, idleMs: 1 });
    const firstRoot = workspace();
    expect(isClient(await pool.acquire(server(), firstRoot))).toBe(true);

    now += 2;
    const sweeping = pool.sweep();
    await vi.waitFor(() => expect(shutdownId).toBeDefined());
    const timedOut = await pool.acquire(server(), workspace(), {
      timeoutMs: 5,
    });
    expect(timedOut).toMatchObject({ available: false });
    now += 10;
    first.stdout.write(encodeMessage({ id: shutdownId, result: null }));
    await sweeping;
    dateNow.mockRestore();

    expect(spawn).toHaveBeenCalledTimes(1);
    await pool.shutdown();
  });

  it("does not evict an idle client after its caller deadline expires", async () => {
    const first = new FakeChild();
    respondToInitialize(first);
    let shutdownId: number | string | null | undefined;
    first.stdin.on("data", (frame: Buffer) => {
      const message = new ContentLengthDecoder().push(frame)[0];
      if (message.method === "shutdown") {
        shutdownId = message.id;
        first.stdout.write(encodeMessage({ id: message.id, result: null }));
      }
    });
    const second = new FakeChild();
    respondToInitialize(second);
    const children = [first, second];
    const spawn = vi.fn(() => children.shift()!) as never;
    const pool = new LspPool({ spawn, maxProcesses: 1 });
    const firstRoot = workspace();
    const client = await pool.acquire(server(), firstRoot);
    expect(isClient(client)).toBe(true);

    let now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    Object.defineProperty(client, "activeRequests", {
      configurable: true,
      get: () => {
        now += 10;
        return 0;
      },
    });
    const replacement = await pool.acquire(server(), workspace(), {
      timeoutMs: 5,
    });
    dateNow.mockRestore();

    expect(replacement).toMatchObject({
      available: false,
      reason: expect.stringMatching(/timed out/),
    });
    expect(shutdownId).toBeUndefined();
    expect(pool.status()).toMatchObject([{ state: "running" }]);
    expect(spawn).toHaveBeenCalledTimes(1);
    await pool.shutdown();
  });

  it("kills a failed start and returns an unavailable cooldown result", async () => {
    const child = new FakeChild();
    const pool = new LspPool({
      spawn: vi.fn(() => child) as never,
      initializeTimeoutMs: 5,
      failureCooldownMs: 1_000,
    });
    const root = workspace();
    const first = await pool.acquire(server(), root);
    const second = await pool.acquire(server(), root);
    expect(isClient(first)).toBe(false);
    expect(first).toMatchObject({ available: false });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(second).toMatchObject({ available: false, coolingDown: true });
    await pool.shutdown();
  });

  it("terminates a crashed client's child before replacement", async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    respondToInitialize(first);
    respondToInitialize(second);
    const children = [first, second];
    const pool = new LspPool({
      spawn: vi.fn(() => children.shift()!) as never,
    });
    const root = workspace();
    expect(isClient(await pool.acquire(server(), root))).toBe(true);
    first.emit("exit", 1, null);
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    expect(isClient(await pool.acquire(server(), root))).toBe(true);
    await pool.shutdown();
  });

  it("removes crashed clients so a later request starts a replacement", async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    respondToInitialize(first);
    respondToInitialize(second);
    const children = [first, second];
    const pool = new LspPool({
      spawn: vi.fn(() => children.shift()!) as never,
    });
    const root = workspace();
    expect(isClient(await pool.acquire(server(), root))).toBe(true);
    first.emit("exit", 1, null);
    expect(isClient(await pool.acquire(server(), root))).toBe(true);
    await pool.shutdown();
  });

  it("shuts down an in-flight start without leaving a live process", async () => {
    const child = new FakeChild();
    const pool = new LspPool({ spawn: vi.fn(() => child) as never });
    const starting = pool.acquire(server(), workspace());
    await vi.waitFor(() => expect(pool.status()[0]?.starting).toBe(true));
    await pool.shutdown();
    expect(isClient(await starting)).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("forcefully stops initialized clients during pool shutdown", async () => {
    const child = new FakeChild();
    respondToInitialize(child);
    const pool = new LspPool({ spawn: vi.fn(() => child) as never });
    const root = workspace();
    expect(isClient(await pool.acquire(server(), root))).toBe(true);
    const methods: string[] = [];
    child.stdin.on("data", (frame: Buffer) => {
      methods.push(new ContentLengthDecoder().push(frame)[0].method!);
    });
    await pool.shutdown();
    expect(methods).not.toContain("shutdown");
    expect(methods).not.toContain("exit");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(pool.status()).toEqual([]);
  });

  it("replaces a closed or invalid global pool manager", async () => {
    const first = getLspPool();
    await first.shutdown();
    const scope = globalThis as Record<symbol, unknown>;
    scope[LSP_POOL_MANAGER_KEY] = {
      pool: { closed: false, acquire() {}, shutdown: "not-a-function" },
    };
    const second = getLspPool();
    expect(second).not.toBe(first);
    await second.shutdown();
  });
});
