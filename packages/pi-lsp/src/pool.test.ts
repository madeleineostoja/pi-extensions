import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentLengthDecoder, encodeMessage } from "./protocol.js";
import { getLspPool, LspPool, type PoolAcquireResult } from "./pool.js";
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
  const directory = mkdtempSync(join(tmpdir(), "pi-lsp-pool-"));
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
function respondToInitialize(child: FakeChild): void {
  child.stdin.on("data", (frame: Buffer) => {
    const message = new ContentLengthDecoder().push(frame)[0];
    if (message.method === "initialize") {
      child.stdout.write(
        encodeMessage({ id: message.id, result: { capabilities: {} } }),
      );
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

  it("replaces a closed global pool", async () => {
    const first = getLspPool();
    await first.shutdown();
    const second = getLspPool();
    expect(second).not.toBe(first);
    await second.shutdown();
  });
});
