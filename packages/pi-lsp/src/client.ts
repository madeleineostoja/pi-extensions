import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { JsonRpcConnection, RequestCancelledError } from "./protocol.js";
import {
  normalizeDiagnostics,
  type NormalizedDiagnostic,
} from "./normalize.js";
import {
  assertWorkspaceFile,
  canonicalPath,
  workspaceFileFromUri,
} from "./workspace.js";

export type SpawnedConnection = JsonRpcConnection;
type Document = {
  version: number;
  hash: string;
  text: string;
  languageId: string;
};
type PushDiagnostics = {
  version?: number;
  hash?: string;
  diagnostics: NormalizedDiagnostic[];
};
type PullDiagnosticsProvider = { identifier?: string };
export type DiagnosticsResult = {
  diagnostics: NormalizedDiagnostic[];
  fresh: boolean;
  stale?: boolean;
  timedOut?: boolean;
  resultId?: string;
};

export class LspClient {
  #connection: SpawnedConnection;
  #workspaceRoot: string;
  #documents = new Map<string, Document>();
  #pushDiagnostics = new Map<string, PushDiagnostics>();
  #pushWaiters = new Map<string, Set<(reason?: Error) => void>>();
  #pullResults = new Map<
    string,
    {
      resultId?: string;
      invalidated: boolean;
      diagnostics: NormalizedDiagnostic[];
    }
  >();
  #capabilities: { diagnosticProvider?: PullDiagnosticsProvider } = {};
  #initialized = false;
  #initializing?: Promise<unknown>;
  #shutdown?: Promise<void>;
  #activeRequests = 0;
  lastActivity = Date.now();

  constructor(connection: SpawnedConnection, workspaceRoot: string) {
    this.#connection = connection;
    this.#workspaceRoot = canonicalPath(workspaceRoot);
    connection.onNotification((method, params) =>
      this.#notification(method, params),
    );
  }
  get activeRequests(): number {
    return this.#activeRequests;
  }
  get openDocumentCount(): number {
    return this.#documents.size;
  }
  get capabilities(): { diagnosticProvider?: PullDiagnosticsProvider } {
    return this.#capabilities;
  }
  async initialize(
    rootUri: string,
    initializationOptions?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (rootUri !== pathToFileURL(this.#workspaceRoot).href) {
      throw new Error("LSP initialize root is outside the selected workspace");
    }
    if (this.#initialized) {
      return undefined;
    }
    if (this.#initializing) {
      return this.#initializing;
    }
    this.#initializing = this.#request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        capabilities: {
          workspace: {
            configuration: true,
            workspaceEdit: { documentChanges: false },
          },
          textDocument: { diagnostic: { dynamicRegistration: false } },
        },
        ...(initializationOptions === undefined
          ? {}
          : { initializationOptions }),
      },
      options,
    )
      .then((result) => {
        const capabilities = (result as { capabilities?: unknown })
          ?.capabilities;
        this.#capabilities = isCapabilities(capabilities) ? capabilities : {};
        this.#connection.notify("initialized", {});
        this.#initialized = true;
        return result;
      })
      .finally(() => {
        this.#initializing = undefined;
      });
    return this.#initializing;
  }
  async synchronize(
    file: string,
    languageId: string,
  ): Promise<{ uri: string; version: number; hash: string }> {
    const path = this.#assertFile(file);
    const uri = pathToFileURL(path).href;
    const text = readFileSync(path, "utf8");
    const hash = digest(text);
    const previous = this.#documents.get(uri);
    if (!previous) {
      const document = { version: 1, hash, text, languageId };
      this.#documents.set(uri, document);
      this.#connection.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: document.version, text },
      });
      return { uri, version: 1, hash };
    }
    if (previous.hash !== hash) {
      previous.version += 1;
      previous.hash = hash;
      previous.text = text;
      this.#connection.notify("textDocument/didChange", {
        textDocument: { uri, version: previous.version },
        contentChanges: [{ text }],
      });
    }
    return { uri, version: previous.version, hash };
  }
  async diagnostics(
    file: string,
    languageId: string,
    capabilities: { diagnosticProvider?: PullDiagnosticsProvider } = this
      .#capabilities,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<DiagnosticsResult> {
    return this.#activity(async () => {
      const document = await this.synchronize(file, languageId);
      if (capabilities.diagnosticProvider) {
        const previous = this.#pullResults.get(document.uri);
        const report = (await this.#request(
          "textDocument/diagnostic",
          {
            textDocument: { uri: document.uri },
            ...(previous?.resultId && !previous.invalidated
              ? { previousResultId: previous.resultId }
              : {}),
          },
          options,
        )) as { kind?: string; items?: unknown[]; resultId?: string };
        if (report?.kind === "unchanged") {
          return {
            diagnostics: previous?.diagnostics ?? [],
            fresh: true,
            resultId: report.resultId ?? previous?.resultId,
          };
        }
        const diagnostics = normalizeDiagnostics(report?.items);
        this.#pullResults.set(document.uri, {
          resultId: report?.resultId,
          invalidated: false,
          diagnostics,
        });
        return { diagnostics, fresh: true, resultId: report?.resultId };
      }
      const cached = this.#pushDiagnostics.get(document.uri);
      if (
        cached?.version === document.version &&
        cached.hash === document.hash
      ) {
        return { diagnostics: cached.diagnostics, fresh: true };
      }
      const fresh = await this.#waitForPush(
        document.uri,
        document.version,
        document.hash,
        options.timeoutMs ?? 1_500,
        options.signal,
      );
      return fresh
        ? { diagnostics: fresh.diagnostics, fresh: true }
        : {
            diagnostics: [],
            fresh: false,
            stale: Boolean(cached),
            timedOut: true,
          };
    });
  }
  async shutdown(options: { force?: boolean } = {}): Promise<void> {
    if (this.#shutdown) {
      if (options.force) {
        this.#clearWaiters();
        this.#connection.close(new Error("LSP client forcefully shut down"));
      }
      return this.#shutdown;
    }
    this.#clearWaiters();
    this.#shutdown = (async () => {
      for (const uri of this.#documents.keys()) {
        try {
          this.#connection.notify("textDocument/didClose", {
            textDocument: { uri },
          });
        } catch {}
      }
      this.#documents.clear();
      if (!options.force && this.#initialized && !this.#connection.closed) {
        try {
          await this.#request("shutdown", {}, { timeoutMs: 1_000 });
        } catch {
        } finally {
          try {
            this.#connection.notify("exit");
          } catch {}
        }
      }
      this.#connection.close();
    })();
    return this.#shutdown;
  }
  #request(
    method: string,
    params: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    return this.#activity(() =>
      this.#connection.request(method, params, options),
    );
  }
  async #activity<T>(operation: () => Promise<T>): Promise<T> {
    this.#activeRequests += 1;
    this.lastActivity = Date.now();
    try {
      return await operation();
    } finally {
      this.#activeRequests -= 1;
      this.lastActivity = Date.now();
    }
  }
  #assertFile(file: string): string {
    return assertWorkspaceFile(this.#workspaceRoot, file);
  }
  #notification(method: string, params: unknown): void {
    if (method === "workspace/diagnostic/refresh") {
      for (const value of this.#pullResults.values()) {
        value.invalidated = true;
      }
      return;
    }
    if (method !== "textDocument/publishDiagnostics") {
      return;
    }
    const value = params as {
      uri?: string;
      version?: number;
      diagnostics?: unknown[];
    };
    if (!value.uri) {
      return;
    }
    const file = workspaceFileFromUri(this.#workspaceRoot, value.uri);
    if (!file || pathToFileURL(file).href !== value.uri) {
      return;
    }
    const doc = this.#documents.get(value.uri);
    const cache: PushDiagnostics = {
      version: value.version,
      hash: doc && value.version === doc.version ? doc.hash : undefined,
      diagnostics: normalizeDiagnostics(value.diagnostics),
    };
    this.#pushDiagnostics.set(value.uri, cache);
    for (const wake of this.#pushWaiters.get(value.uri) ?? []) {
      wake();
    }
  }
  #waitForPush(
    uri: string,
    version: number,
    hash: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PushDiagnostics | undefined> {
    return new Promise((resolve, reject) => {
      const find = () => {
        const value = this.#pushDiagnostics.get(uri);
        return value?.version === version && value.hash === hash
          ? value
          : undefined;
      };
      const existing = find();
      if (existing) {
        resolve(existing);
        return;
      }
      let settled = false;
      const waiters =
        this.#pushWaiters.get(uri) ?? new Set<(reason?: Error) => void>();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        waiters.delete(wake);
        if (waiters.size === 0) {
          this.#pushWaiters.delete(uri);
        }
      };
      const finish = (value: PushDiagnostics | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };
      const wake = (reason?: Error) => {
        if (reason) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(reason);
          }
          return;
        }
        const value = find();
        if (value) {
          finish(value);
        }
      };
      const abort = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new RequestCancelledError("LSP diagnostics request cancelled"));
      };
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      waiters.add(wake);
      this.#pushWaiters.set(uri, waiters);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
      }
    });
  }
  #clearWaiters(): void {
    for (const waiters of this.#pushWaiters.values()) {
      for (const wake of waiters) {
        wake(new Error("LSP client shut down"));
      }
    }
    this.#pushWaiters.clear();
  }
}
function isCapabilities(
  value: unknown,
): value is { diagnosticProvider?: PullDiagnosticsProvider } {
  return Boolean(value && typeof value === "object");
}
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
