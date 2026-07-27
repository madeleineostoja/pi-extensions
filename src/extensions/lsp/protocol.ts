import { EventEmitter } from "node:events";

export type JsonRpcId = number | string | null;
export type JsonRpcError = { code: number; message: string; data?: unknown };
export type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
};

export class ProtocolError extends Error {}
export class RequestTimeoutError extends Error {}
export class RequestCancelledError extends Error {}

export class ContentLengthDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer | Uint8Array): JsonRpcMessage[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const messages: JsonRpcMessage[] = [];
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return messages;
      }
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const contentLength = this.#contentLength(header);
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + contentLength) {
        return messages;
      }
      const body = this.#buffer.subarray(bodyStart, bodyStart + contentLength);
      this.#buffer = this.#buffer.subarray(bodyStart + contentLength);
      try {
        const message: unknown = JSON.parse(body.toString("utf8"));
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          throw new Error("message is not an object");
        }
        messages.push(message as JsonRpcMessage);
      } catch (error) {
        throw new ProtocolError(`Invalid JSON-RPC payload: ${String(error)}`);
      }
    }
  }

  #contentLength(headers: string): number {
    const values = headers.split("\r\n").map((line) => line.split(/:\s*/, 2));
    const raw = values.find(
      ([name]) => name.toLowerCase() === "content-length",
    )?.[1];
    if (!raw || !/^\d+$/.test(raw)) {
      throw new ProtocolError("Missing or invalid Content-Length header");
    }
    const size = Number(raw);
    if (!Number.isSafeInteger(size) || size > 32 * 1024 * 1024) {
      throw new ProtocolError("Invalid Content-Length size");
    }
    return size;
  }
}

export function encodeMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(
    JSON.stringify({ jsonrpc: "2.0", ...message }),
    "utf8",
  );
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

export type JsonRpcTransport = EventEmitter & {
  stdin?: { write(data: Buffer): boolean; end(): void } | null;
  stdout?: EventEmitter | null;
  stderr?: EventEmitter | null;
  kill?(signal?: NodeJS.Signals): boolean;
};

type Pending = {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
  sent: boolean;
};
export type ServerRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown> | unknown;

export class JsonRpcConnection {
  #transport: JsonRpcTransport;
  #decoder = new ContentLengthDecoder();
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  #stderr = "";
  #events = new EventEmitter();
  #serverRequest: ServerRequestHandler;

  constructor(
    transport: JsonRpcTransport,
    serverRequest?: ServerRequestHandler,
  ) {
    this.#transport = transport;
    this.#serverRequest = serverRequest ?? defaultServerRequest;
    transport.stdout?.on("data", (chunk: Buffer) => this.#receive(chunk));
    transport.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-16_384);
      this.#events.emit("stderr", chunk.toString("utf8"));
    });
    transport.once("error", (error) => this.#close(error));
    transport.once("exit", (code, signal) =>
      this.#close(
        new Error(`LSP process exited (${code ?? "null"}/${signal ?? "none"})`),
      ),
    );
    transport.once("close", (code, signal) =>
      this.#close(
        new Error(`LSP process closed (${code ?? "null"}/${signal ?? "none"})`),
      ),
    );
  }

  get stderr(): string {
    return this.#stderr;
  }
  get closed(): boolean {
    return this.#closed;
  }
  onNotification(
    listener: (method: string, params: unknown) => void,
  ): () => void {
    this.#events.on("notification", listener);
    return () => this.#events.off("notification", listener);
  }
  onServerRequest(
    listener: (method: string, params: unknown) => void,
  ): () => void {
    this.#events.on("serverRequest", listener);
    return () => this.#events.off("serverRequest", listener);
  }
  onClose(listener: (reason: Error) => void): () => void {
    this.#events.on("close", listener);
    return () => this.#events.off("close", listener);
  }
  onStderr(listener: (value: string) => void): () => void {
    this.#events.on("stderr", listener);
    return () => this.#events.off("stderr", listener);
  }

  notify(method: string, params?: unknown): void {
    try {
      this.#write({ method, ...(params === undefined ? {} : { params }) });
    } catch {}
  }

  request(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (options.signal?.aborted) {
      return Promise.reject(
        new RequestCancelledError(`LSP request cancelled: ${method}`),
      );
    }
    if (this.#closed) {
      return Promise.reject(
        new Error(`LSP connection is closed: ${this.#stderr}`),
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const pending = this.#pending.get(id);
        if (!pending) {
          return;
        }
        if (pending.sent) {
          this.#safeNotify("$/cancelRequest", { id });
        }
        this.#settle(
          id,
          new RequestCancelledError(`LSP request cancelled: ${method}`),
        );
      };
      const pending: Pending = {
        resolve,
        reject,
        signal: options.signal,
        abort: cancel,
        sent: false,
      };
      if (options.timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          if (this.#pending.get(id)?.sent) {
            this.#safeNotify("$/cancelRequest", { id });
          }
          this.#settle(
            id,
            new RequestTimeoutError(`LSP request timed out: ${method}`),
          );
        }, options.timeoutMs);
      }
      this.#pending.set(id, pending);
      options.signal?.addEventListener("abort", cancel, { once: true });
      try {
        this.#write({
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
        const active = this.#pending.get(id);
        if (active) {
          active.sent = true;
        }
      } catch (error) {
        this.#settle(
          id,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  close(reason = new Error("LSP connection closed")): void {
    this.#close(reason);
  }

  #write(message: JsonRpcMessage): void {
    if (this.#closed || !this.#transport.stdin) {
      throw new Error("LSP stdin is unavailable");
    }
    this.#transport.stdin.write(encodeMessage(message));
  }
  #safeNotify(method: string, params?: unknown): void {
    this.notify(method, params);
  }
  #receive(chunk: Buffer): void {
    try {
      for (const message of this.#decoder.push(chunk)) {
        void this.#handle(message);
      }
    } catch (error) {
      this.#close(error instanceof Error ? error : new Error(String(error)));
    }
  }
  async #handle(message: JsonRpcMessage): Promise<void> {
    if (message.id !== undefined && message.method === undefined) {
      if (typeof message.id !== "number") {
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(message.id);
      this.#clearPending(pending);
      if (message.error) {
        pending.reject(
          Object.assign(new Error(message.error.message), {
            code: message.error.code,
            data: message.error.data,
          }),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!message.method) {
      return;
    }
    if (message.id === undefined) {
      this.#events.emit("notification", message.method, message.params);
      return;
    }
    try {
      this.#events.emit("serverRequest", message.method, message.params);
      const result = await this.#serverRequest(message.method, message.params);
      this.#safeReply({ id: message.id, result });
    } catch (error) {
      const item = error as { code?: number; message?: string };
      this.#safeReply({
        id: message.id,
        error: {
          code: item.code ?? -32601,
          message: item.message ?? "Method not found",
        },
      });
    }
  }
  #safeReply(message: JsonRpcMessage): void {
    try {
      this.#write(message);
    } catch {}
  }
  #settle(id: number, error: Error): void {
    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }
    this.#pending.delete(id);
    this.#clearPending(pending);
    pending.reject(error);
  }
  #clearPending(pending: Pending): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    if (pending.signal && pending.abort) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
  }
  #close(reason: Error): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const id of this.#pending.keys()) {
      this.#settle(id, reason);
    }
    this.#events.emit("close", reason);
  }
}

function defaultServerRequest(method: string, params: unknown): unknown {
  if (method === "workspace/applyEdit") {
    return { applied: false, failureReason: "LSP is read-only" };
  }
  if (method === "workspace/configuration") {
    return Array.isArray((params as { items?: unknown[] } | undefined)?.items)
      ? (params as { items: unknown[] }).items.map(() => ({}))
      : [];
  }
  if (
    method === "client/registerCapability" ||
    method === "client/unregisterCapability" ||
    method === "window/workDoneProgress/create" ||
    method === "workspace/diagnostic/refresh"
  ) {
    return null;
  }
  throw Object.assign(new Error(`Method not found: ${method}`), {
    code: -32601,
  });
}
