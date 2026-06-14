import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentDefinitionRegistry,
  PUBLIC_BUILTIN_TYPES,
  type AgentDefinitionRegistry,
} from "./definitions.js";
import {
  loadPublicConfig,
  type ResolvedPublicSubagentsConfig,
  type ThinkingLevel,
} from "./config.js";

export type SubagentRuntimeStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type ExtensionBindingStatus = "bound" | "unbound";

export type SandboxMode =
  | "inherit"
  | "none"
  | "read-only"
  | "workspace-write"
  | string;

export type RuntimeTimestamps = {
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type RuntimeSnapshot = {
  id: string;
  status: SubagentRuntimeStatus;
  owner: string;
  type: string;
  description: string;
  cwd: string;
  model?: string;
  thinking: ThinkingLevel;
  extensionBinding: ExtensionBindingStatus;
  sandboxMode?: SandboxMode;
  timestamps: RuntimeTimestamps;
  result?: unknown;
  error?: string;
};

export type QueueSubagentInput = {
  owner: string;
  type: string;
  description: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  extensionBinding?: ExtensionBindingStatus;
  sandboxMode?: SandboxMode;
};

type RuntimeRecord = Omit<RuntimeSnapshot, "timestamps"> & RuntimeTimestamps;

type Waiter = {
  resolve: (snapshot: RuntimeSnapshot) => void;
};

const runtimes = new WeakMap<ExtensionAPI, SubagentRuntime>();
const publicTypes = new Set<string>(PUBLIC_BUILTIN_TYPES);

function now(): string {
  return new Date().toISOString();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshot(record: RuntimeRecord): RuntimeSnapshot {
  return {
    id: record.id,
    status: record.status,
    owner: record.owner,
    type: record.type,
    description: record.description,
    cwd: record.cwd,
    ...(record.model === undefined ? {} : { model: record.model }),
    thinking: record.thinking,
    extensionBinding: record.extensionBinding,
    ...(record.sandboxMode === undefined
      ? {}
      : { sandboxMode: record.sandboxMode }),
    timestamps: {
      queuedAt: record.queuedAt,
      ...(record.startedAt === undefined
        ? {}
        : { startedAt: record.startedAt }),
      ...(record.completedAt === undefined
        ? {}
        : { completedAt: record.completedAt }),
      updatedAt: record.updatedAt,
    },
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

function isTerminal(status: SubagentRuntimeStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

export class SubagentRuntime {
  readonly definitions: AgentDefinitionRegistry;
  readonly publicConfig: ResolvedPublicSubagentsConfig;
  #records = new Map<string, RuntimeRecord>();
  #waiters = new Map<string, Waiter[]>();
  #nextId = 1;

  constructor(
    public readonly pi: ExtensionAPI,
    options: { publicConfig?: ResolvedPublicSubagentsConfig } = {},
  ) {
    this.definitions = createAgentDefinitionRegistry();
    this.publicConfig =
      options.publicConfig ??
      loadPublicConfig({
        warn: (message) => {
          try {
            pi.sendMessage({
              customType: "pi-subagents.config.warning",
              content: `[pi-subagents] ${message}`,
              display: true,
            });
          } catch {
            // best-effort warning for test doubles and early startup
          }
        },
      });
  }

  queue(input: QueueSubagentInput): RuntimeSnapshot {
    const id = `subagent-${this.#nextId++}`;
    const timestamp = now();
    const model =
      input.model ??
      (publicTypes.has(input.type)
        ? this.publicConfig.models[
            input.type as keyof ResolvedPublicSubagentsConfig["models"]
          ]
        : undefined);
    const thinking =
      input.thinking ??
      (publicTypes.has(input.type)
        ? this.publicConfig.thinking[
            input.type as keyof ResolvedPublicSubagentsConfig["thinking"]
          ]
        : "medium");

    const record: RuntimeRecord = {
      id,
      status: "queued",
      owner: input.owner,
      type: input.type,
      description: input.description,
      cwd: input.cwd,
      ...(model === undefined ? {} : { model }),
      thinking,
      extensionBinding: input.extensionBinding ?? "unbound",
      ...(input.sandboxMode === undefined
        ? {}
        : { sandboxMode: input.sandboxMode }),
      queuedAt: timestamp,
      updatedAt: timestamp,
    };
    this.#records.set(id, record);
    return snapshot(record);
  }

  start(id: string): RuntimeSnapshot {
    const record = this.#requireRecord(id);
    if (record.status !== "queued") {
      throw new Error(`Cannot start subagent ${id} from ${record.status}`);
    }
    const timestamp = now();
    record.status = "running";
    record.startedAt = timestamp;
    record.updatedAt = timestamp;
    return snapshot(record);
  }

  complete(id: string, result: unknown): RuntimeSnapshot {
    const record = this.#requireRecord(id);
    this.#ensureNotTerminal(record);
    const timestamp = now();
    record.status = "completed";
    record.result = result;
    record.completedAt = timestamp;
    record.updatedAt = timestamp;
    return this.#finish(record);
  }

  fail(id: string, error: unknown): RuntimeSnapshot {
    const record = this.#requireRecord(id);
    this.#ensureNotTerminal(record);
    const timestamp = now();
    record.status = "failed";
    record.error = errorText(error);
    record.completedAt = timestamp;
    record.updatedAt = timestamp;
    return this.#finish(record);
  }

  stop(id: string, error = "Stopped by user."): RuntimeSnapshot {
    const record = this.#requireRecord(id);
    this.#ensureNotTerminal(record);
    const timestamp = now();
    record.status = "stopped";
    record.error = error;
    record.completedAt = timestamp;
    record.updatedAt = timestamp;
    return this.#finish(record);
  }

  steer(id: string, message: string): RuntimeSnapshot {
    const record = this.#requireRecord(id);
    if (record.status !== "running") {
      throw new Error(`Cannot steer subagent ${id} from ${record.status}`);
    }
    if (message.trim() === "") {
      throw new Error("Steer message must not be empty");
    }
    record.updatedAt = now();
    return snapshot(record);
  }

  wait(id: string): Promise<RuntimeSnapshot> {
    const record = this.#requireRecord(id);
    if (isTerminal(record.status)) {
      return Promise.resolve(snapshot(record));
    }
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(id) ?? [];
      waiters.push({ resolve });
      this.#waiters.set(id, waiters);
    });
  }

  snapshot(id: string): RuntimeSnapshot | undefined {
    const record = this.#records.get(id);
    return record ? snapshot(record) : undefined;
  }

  snapshots(): RuntimeSnapshot[] {
    return [...this.#records.values()].map((record) => snapshot(record));
  }

  #requireRecord(id: string): RuntimeRecord {
    const record = this.#records.get(id);
    if (!record) {
      throw new Error(`Unknown subagent ${id}`);
    }
    return record;
  }

  #ensureNotTerminal(record: RuntimeRecord): void {
    if (isTerminal(record.status)) {
      throw new Error(`Subagent ${record.id} already ${record.status}`);
    }
  }

  #finish(record: RuntimeRecord): RuntimeSnapshot {
    const finalSnapshot = snapshot(record);
    const waiters = this.#waiters.get(record.id) ?? [];
    this.#waiters.delete(record.id);
    for (const waiter of waiters) {
      waiter.resolve(finalSnapshot);
    }
    return finalSnapshot;
  }
}

export function getSubagentRuntime(pi: ExtensionAPI): SubagentRuntime {
  const existing = runtimes.get(pi);
  if (existing) {
    return existing;
  }
  const runtime = new SubagentRuntime(pi);
  runtimes.set(pi, runtime);
  return runtime;
}
