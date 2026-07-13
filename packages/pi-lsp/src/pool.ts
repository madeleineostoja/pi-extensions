import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { LspClient } from "./client.js";
import { JsonRpcConnection } from "./protocol.js";
import type { ResolvedServer } from "./server.js";
import { canonicalPath } from "./workspace.js";

export type PoolKey = `${string}|${string}|${string}`;
type Entry = {
  key: PoolKey;
  client?: LspClient;
  process?: ChildProcess;
  starting?: Promise<LspClient>;
  abortStart?: () => void;
  lastActivity: number;
  failedAt?: number;
  failure?: Error;
  disposed?: boolean;
};
export type PoolUnavailable = {
  available: false;
  reason: string;
  coolingDown?: boolean;
};
export type PoolAcquireResult = LspClient | PoolUnavailable;
export type LspPoolOptions = {
  maxProcesses?: number;
  idleMs?: number;
  failureCooldownMs?: number;
  initializeTimeoutMs?: number;
  spawn?: typeof spawn;
};
const managerKey = Symbol.for("pi-lsp:pool");
const defaultOptions = {
  maxProcesses: 6,
  idleMs: 5 * 60_000,
  failureCooldownMs: 10_000,
  initializeTimeoutMs: 15_000,
};

export class LspPool {
  #entries = new Map<PoolKey, Entry>();
  #options: Required<Omit<LspPoolOptions, "spawn">> &
    Pick<LspPoolOptions, "spawn">;
  #timer: ReturnType<typeof setInterval>;
  #exitHandler: () => void;
  #closed = false;
  #lock = Promise.resolve();

  constructor(options: LspPoolOptions = {}) {
    this.#options = { ...defaultOptions, ...options };
    this.#timer = setInterval(
      () => void this.sweep(),
      Math.min(this.#options.idleMs, 60_000),
    ).unref();
    this.#exitHandler = () => {
      for (const entry of this.#entries.values()) {
        entry.abortStart?.();
        this.#terminate(entry.process);
      }
    };
    process.once("exit", this.#exitHandler);
  }

  get closed(): boolean {
    return this.#closed;
  }

  key(server: ResolvedServer, workspaceRoot: string): PoolKey {
    return `${server.kind}|${canonicalPath(workspaceRoot)}|${server.executableIdentity}`;
  }

  async acquire(
    server: ResolvedServer,
    workspaceRoot: string,
  ): Promise<PoolAcquireResult> {
    const root = canonicalPath(workspaceRoot);
    const key = this.key(server, root);
    let entry: Entry | undefined;
    try {
      entry = await this.#withLock(async () => {
        if (this.#closed) {
          return undefined;
        }
        const existing = this.#entries.get(key);
        if (existing?.client || existing?.starting) {
          existing.lastActivity = Date.now();
          return existing;
        }
        if (
          existing?.failedAt &&
          Date.now() - existing.failedAt < this.#options.failureCooldownMs
        ) {
          return existing;
        }
        await this.#makeRoom();
        const created: Entry = { key, lastActivity: Date.now() };
        this.#entries.set(key, created);
        created.starting = this.#start(created, server, root);
        return created;
      });
    } catch (error) {
      return this.#unavailable(asError(error));
    }
    if (!entry) {
      return { available: false, reason: "LSP pool is shut down" };
    }
    if (entry.client) {
      return entry.client;
    }
    if (entry.starting) {
      try {
        return await entry.starting;
      } catch (error) {
        return this.#unavailable(asError(error));
      }
    }
    return this.#unavailable(entry.failure, Boolean(entry.failedAt));
  }

  async sweep(): Promise<void> {
    await this.#withLock(async () => {
      const now = Date.now();
      for (const [key, entry] of this.#entries) {
        if (
          entry.client &&
          entry.client.activeRequests === 0 &&
          now - Math.max(entry.lastActivity, entry.client.lastActivity) >
            this.#options.idleMs
        ) {
          await this.#dispose(key, entry);
        }
      }
    });
  }

  async shutdown(): Promise<void> {
    await this.#withLock(async () => {
      if (this.#closed) {
        return;
      }
      this.#closed = true;
      clearInterval(this.#timer);
      process.removeListener("exit", this.#exitHandler);
      for (const [key, entry] of this.#entries) {
        await this.#dispose(key, entry, true);
      }
    });
  }

  status(): Array<{
    key: string;
    activeRequests: number;
    openDocuments: number;
    failed: boolean;
    starting: boolean;
  }> {
    return [...this.#entries.values()].map((entry) => ({
      key: entry.key,
      activeRequests: entry.client?.activeRequests ?? 0,
      openDocuments: entry.client?.openDocumentCount ?? 0,
      failed: Boolean(entry.failure),
      starting: Boolean(entry.starting),
    }));
  }

  async #start(
    entry: Entry,
    server: ResolvedServer,
    workspaceRoot: string,
  ): Promise<LspClient> {
    let child: ChildProcess | undefined;
    let client: LspClient | undefined;
    try {
      child = (this.#options.spawn ?? spawn)(server.command, server.args, {
        cwd: workspaceRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      entry.process = child;
      const connection = new JsonRpcConnection(child);
      entry.abortStart = () =>
        connection.close(new Error("LSP startup was cancelled"));
      client = new LspClient(connection, workspaceRoot);
      connection.onClose(() => {
        if (entry.client === client && this.#entries.get(entry.key) === entry) {
          this.#entries.delete(entry.key);
        }
      });
      await client.initialize(
        pathToFileURL(workspaceRoot).href,
        server.typescript
          ? { tsserver: { path: server.typescript.path } }
          : undefined,
        { timeoutMs: this.#options.initializeTimeoutMs },
      );
      if (
        this.#closed ||
        entry.disposed ||
        this.#entries.get(entry.key) !== entry
      ) {
        await client.shutdown();
        throw new Error("LSP startup was cancelled");
      }
      entry.client = client;
      entry.starting = undefined;
      entry.abortStart = undefined;
      entry.failure = undefined;
      entry.failedAt = undefined;
      entry.lastActivity = Date.now();
      return client;
    } catch (error) {
      entry.abortStart = undefined;
      entry.starting = undefined;
      this.#terminate(child);
      const failure = asError(error);
      if (!entry.disposed && this.#entries.get(entry.key) === entry) {
        entry.failedAt = Date.now();
        entry.failure = failure;
      }
      throw failure;
    }
  }

  async #makeRoom(): Promise<void> {
    const live = [...this.#entries.entries()].filter(
      ([, entry]) => entry.client || entry.starting,
    );
    if (live.length < this.#options.maxProcesses) {
      return;
    }
    const candidate = live
      .filter(([, entry]) => entry.client && entry.client.activeRequests === 0)
      .sort((a, b) => a[1].lastActivity - b[1].lastActivity)[0];
    if (!candidate) {
      throw new Error("LSP process limit reached with only active clients");
    }
    await this.#dispose(...candidate);
  }

  async #dispose(key: PoolKey, entry: Entry, force = false): Promise<void> {
    if (!force && (entry.client?.activeRequests || entry.starting)) {
      return;
    }
    entry.disposed = true;
    if (this.#entries.get(key) === entry) {
      this.#entries.delete(key);
    }
    entry.abortStart?.();
    try {
      await entry.client?.shutdown();
    } finally {
      this.#terminate(entry.process);
    }
  }

  #terminate(child: ChildProcess | undefined): void {
    if (!child) {
      return;
    }
    let exited = false;
    child.once("close", () => {
      exited = true;
    });
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }, 1_000);
    timer.unref();
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #unavailable(error?: Error, coolingDown = false): PoolUnavailable {
    return {
      available: false,
      reason: error?.message ?? "LSP server is unavailable",
      ...(coolingDown ? { coolingDown: true } : {}),
    };
  }
}

type GlobalManager = { pool?: { closed?: unknown; acquire?: unknown } };
export function getLspPool(): LspPool {
  const scope = globalThis as Record<symbol, unknown>;
  const existing = scope[managerKey] as GlobalManager | undefined;
  if (
    existing?.pool &&
    existing.pool.closed === false &&
    typeof existing.pool.acquire === "function"
  ) {
    return existing.pool as LspPool;
  }
  const manager = { pool: new LspPool() };
  scope[managerKey] = manager;
  return manager.pool;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
