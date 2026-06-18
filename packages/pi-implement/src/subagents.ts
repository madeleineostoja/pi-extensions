import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getSubagentRuntime } from "pi-subagents/runtime";
import type { RuntimeSnapshot, ThinkingLevel } from "pi-subagents/runtime";

export type SubagentClient = {
  probe(timeoutMs?: number): Promise<ProbeResult>;
  spawn(args: SpawnArgs): Promise<string>;
  stop(id: string): Promise<void>;
  waitFor(id: string, signal?: AbortSignal): Promise<SubagentResult>;
  snapshots?(ids?: string[]): AgentSnapshot[];
};

export type ProbeResult = { ok: true; version?: number } | { ok: false };

export type PiImplementWorkerRole =
  | "implementer"
  | "reviewer"
  | "planner"
  | "selfHeal";

export type SpawnArgs = {
  type: string;
  prompt: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
  cwd?: string;
  role?: PiImplementWorkerRole;
  taskId?: string;
  readOnly?: boolean;
};

export type AgentSnapshot = {
  id: string;
  status?: string;
  description?: string;
  toolUses?: number;
  tokensTotal?: number;
  compactionCount?: number;
  cwd?: string;
  model?: string;
  thinking?: ThinkingLevel;
};

export type SubagentResult =
  | { status: "completed"; result: string }
  | { status: "failed"; error: string }
  | { status: "stopped"; error: string };

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls", "explore"];
const MUTATING_TOOLS = [
  "edit",
  "write",
  "Agent",
  "get_subagent_result",
  "steer_subagent",
];

export class RuntimeSubagentClient implements SubagentClient {
  private readonly runtime;

  constructor(
    pi: ExtensionAPI,
    private readonly ctx: ExtensionCommandContext,
    private readonly runId: string,
  ) {
    this.runtime = getSubagentRuntime(pi);
    registerPiImplementDefinitions(this.runtime);
  }

  async probe(): Promise<ProbeResult> {
    return { ok: true, version: 3 };
  }

  async spawn(args: SpawnArgs): Promise<string> {
    const cwd = args.cwd ?? this.ctx.cwd;
    const role = args.role ?? "implementer";
    const snapshot = await this.runtime.runManagedAgent({
      owner: {
        kind: "pi-implement",
        runId: this.runId,
        role,
        ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
      },
      type: args.type,
      prompt: args.prompt,
      description: args.description,
      cwd,
      model: args.model,
      thinking: args.thinking,
      mode: "background",
      ctx: this.ctx,
      rosterVisibility: "hide",
      ...(args.readOnly || role === "reviewer" || role === "planner"
        ? { tools: READ_ONLY_TOOLS, excludeTools: MUTATING_TOOLS }
        : {}),
    });
    return snapshot.id;
  }

  async stop(id: string): Promise<void> {
    this.runtime.stop(id);
  }

  waitFor(id: string, signal?: AbortSignal): Promise<SubagentResult> {
    if (signal?.aborted) {
      return Promise.resolve({ status: "stopped", error: "Stopped by user." });
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: SubagentResult) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = () => {
        try {
          this.runtime.stop(id);
        } catch {
          // The runtime may already have completed the worker.
        }
        finish({ status: "stopped", error: "Stopped by user." });
      };
      signal?.addEventListener("abort", abort, { once: true });
      void this.runtime.wait(id).then((snapshot) => {
        if (snapshot.status === "completed") {
          finish({
            status: "completed",
            result: subagentResultText(snapshot.result),
          });
          return;
        }
        finish({
          status: snapshot.status === "stopped" ? "stopped" : "failed",
          error: snapshot.error ?? `Subagent ${snapshot.status}.`,
        });
      });
    });
  }

  snapshots(ids?: string[]): AgentSnapshot[] {
    const idSet = ids ? new Set(ids) : undefined;
    return this.runtime
      .snapshots({ includeNested: true })
      .filter((snapshot: RuntimeSnapshot) => !idSet || idSet.has(snapshot.id))
      .map(toAgentSnapshot);
  }
}

function registerPiImplementDefinitions(
  runtime: ReturnType<typeof getSubagentRuntime>,
): void {
  for (const definition of [
    {
      type: "pi-implement:implementer",
      title: "pi-implement implementer",
      description: "Internal write-capable worker for one pi-implement task.",
    },
    {
      type: "pi-implement:reviewer",
      title: "pi-implement reviewer",
      description:
        "Internal read-only reviewer for pi-implement task candidates.",
    },
    {
      type: "pi-implement:planner",
      title: "pi-implement planner",
      description:
        "Internal read-only execution manifest planner for pi-implement.",
    },
    {
      type: "pi-implement:self-heal",
      title: "pi-implement self-heal",
      description:
        "Internal worker for scheduler and integration repair prompts.",
    },
  ]) {
    runtime.definitions.register({ ...definition, visibility: "internal" });
  }
}

function toAgentSnapshot(snapshot: RuntimeSnapshot): AgentSnapshot {
  return {
    id: snapshot.id,
    status: snapshot.status,
    description: snapshot.description,
    toolUses: snapshot.health?.toolUses,
    tokensTotal: snapshot.health?.tokensTotal,
    cwd: snapshot.cwd,
    model: snapshot.model,
    thinking: snapshot.thinking,
  };
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
