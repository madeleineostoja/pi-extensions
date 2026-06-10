type EventBus = {
  on(event: string, handler: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
};

export type SubagentClient = {
  probe(timeoutMs?: number): Promise<ProbeResult>;
  spawn(args: SpawnArgs): Promise<string>;
  stop(id: string): Promise<void>;
  waitFor(id: string, signal?: AbortSignal): Promise<SubagentResult>;
};

export type ProbeResult = { ok: true; version?: number } | { ok: false };

export type SpawnArgs = {
  type: string;
  prompt: string;
  description: string;
  model?: string;
  cwd?: string;
};

export type SubagentResult =
  | { status: "completed"; result: string }
  | { status: "failed"; error: string }
  | { status: "stopped"; error: string };

type RpcReply =
  | { success: true; data?: unknown }
  | { success: false; error?: string };

export class EventSubagentClient implements SubagentClient {
  private counter = 0;

  constructor(
    private readonly events: EventBus,
    private readonly rpcTimeoutMs = 10_000,
  ) {}

  async probe(timeoutMs = 2_000): Promise<ProbeResult> {
    try {
      const data = await this.rpc<{ version?: number }>("ping", {}, timeoutMs);
      return { ok: true, version: data.version };
    } catch {
      return { ok: false };
    }
  }

  async spawn(args: SpawnArgs): Promise<string> {
    const options: {
      description: string;
      isBackground: boolean;
      model?: string;
      cwd?: string;
    } = {
      description: args.description,
      isBackground: true,
    };
    if (args.model !== undefined) {
      options.model = args.model;
    }
    if (args.cwd !== undefined) {
      options.cwd = args.cwd;
    }
    const data = await this.rpc<{ id?: string }>("spawn", {
      type: args.type,
      prompt: args.prompt,
      options,
    });
    if (!data.id) {
      throw new Error("pi-subagents spawn reply did not include an agent id.");
    }
    return data.id;
  }

  async stop(id: string): Promise<void> {
    await this.rpc("stop", { agentId: id });
  }

  waitFor(id: string, signal?: AbortSignal): Promise<SubagentResult> {
    return new Promise((resolve) => {
      let offCompleted = () => {};
      let offFailed = () => {};
      let offAbort = () => {};
      let settled = false;
      const done = (result: SubagentResult) => {
        if (settled) {
          return;
        }
        settled = true;
        offCompleted();
        offFailed();
        offAbort();
        resolve(result);
      };
      const abort = () =>
        done({ status: "stopped", error: "Stopped by user." });
      if (signal?.aborted) {
        abort();
        return;
      }
      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
        offAbort = () => signal.removeEventListener("abort", abort);
      }
      offCompleted = this.events.on("subagents:completed", (payload) => {
        const event = payload as {
          id?: string;
          result?: unknown;
          status?: string;
        };
        if (event.id !== id) {
          return;
        }
        if (event.status === "stopped") {
          done({ status: "stopped", error: "Subagent stopped." });
        } else {
          done({
            status: "completed",
            result: subagentResultText(event.result),
          });
        }
      });
      offFailed = this.events.on("subagents:failed", (payload) => {
        const event = payload as {
          id?: string;
          error?: unknown;
          status?: string;
        };
        if (event.id !== id) {
          return;
        }
        done({
          status: event.status === "stopped" ? "stopped" : "failed",
          error: String(event.error ?? "Subagent failed."),
        });
      });
    });
  }

  private rpc<T>(
    method: "ping" | "spawn" | "stop",
    payload: Record<string, unknown>,
    timeoutMs = this.rpcTimeoutMs,
  ): Promise<T> {
    const requestId = `pi-implement-${Date.now()}-${++this.counter}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe();
        reject(
          new Error(`Timed out waiting for pi-subagents ${method} reply.`),
        );
      }, timeoutMs);
      const unsubscribe = this.events.on(
        `subagents:rpc:${method}:reply:${requestId}`,
        (raw) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          unsubscribe();
          const reply = raw as RpcReply;
          if (!reply.success) {
            reject(new Error(reply.error ?? `pi-subagents ${method} failed.`));
            return;
          }
          resolve((reply.data ?? {}) as T);
        },
      );
      this.events.emit(`subagents:rpc:${method}`, { requestId, ...payload });
    });
  }
}

export function subagentResultText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(subagentResultText).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") {
    return String(value);
  }
  const object = value as Record<string, unknown>;
  for (const key of ["result", "output", "text", "content", "message"]) {
    const nested = object[key];
    if (nested !== undefined) {
      const text = subagentResultText(nested);
      if (text) {
        return text;
      }
    }
  }
  if (object.type === "text" && typeof object.text === "string") {
    return object.text;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
