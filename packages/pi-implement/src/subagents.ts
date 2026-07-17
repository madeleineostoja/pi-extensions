import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getSubagentRuntime } from "pi-subagents/runtime";
import type { RuntimeSnapshot, ThinkingLevel } from "pi-subagents/runtime";
import type { Static, TSchema } from "typebox";

export type SubagentHandle<TResult = unknown> = string & {
  readonly __subagentResult?: TResult;
};

export type SubagentClient = {
  probe(timeoutMs?: number): Promise<ProbeResult>;
  spawn<TSchemaValue extends TSchema = TSchema>(
    args: SpawnArgs<TSchemaValue>,
  ): Promise<SubagentHandle<Static<TSchemaValue>>>;
  stop(id: string): Promise<void>;
  waitFor<TResult = any>(
    id: SubagentHandle<TResult>,
    signal?: AbortSignal,
  ): Promise<SubagentResult<TResult>>;
  snapshots?(ids?: string[]): AgentSnapshot[];
};

export type ProbeResult = { ok: true; version?: number } | { ok: false };

export type PiImplementWorkerRole =
  | "implementer"
  | "reviewer"
  | "planner"
  | "selfHeal";

export type SpawnArgs<TSchemaValue extends TSchema = TSchema> = {
  type: string;
  prompt: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
  cwd?: string;
  role?: PiImplementWorkerRole;
  taskId?: string;
  readOnly?: boolean;
  completion?: {
    description: string;
    schema: TSchemaValue;
    label?: string;
  };
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

export type SubagentResult<TResult = any> =
  | { status: "completed"; result: TResult; runtime?: AgentSnapshot }
  | { status: "failed"; error: string; runtime?: AgentSnapshot }
  | { status: "stopped"; error: string; runtime?: AgentSnapshot };

const READ_ONLY_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "explore",
  "lsp",
];
const MUTATING_TOOLS = [
  "edit",
  "write",
  "propose_papercut",
  "Agent",
  "get_subagent_result",
  "steer_subagent",
];

export class RuntimeSubagentClient implements SubagentClient {
  private readonly runtime;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionCommandContext,
    private readonly runId: string,
  ) {
    this.runtime = getSubagentRuntime(pi);
    registerPiImplementDefinitions(this.runtime);
  }

  async probe(): Promise<ProbeResult> {
    return { ok: true, version: 3 };
  }

  async spawn<TSchemaValue extends TSchema = TSchema>(
    args: SpawnArgs<TSchemaValue>,
  ): Promise<SubagentHandle<Static<TSchemaValue>>> {
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
      completion: args.completion as never,
      ...(args.readOnly || role === "reviewer" || role === "planner"
        ? {
            tools: READ_ONLY_TOOLS.filter(
              (name) =>
                this.pi.getActiveTools?.().includes(name) ?? name !== "lsp",
            ),
            excludeTools: MUTATING_TOOLS,
          }
        : { excludeTools: ["propose_papercut"] }),
    });
    return snapshot.id as SubagentHandle<Static<TSchemaValue>>;
  }

  async stop(id: string): Promise<void> {
    this.runtime.stop(id);
  }

  async waitFor<TResult = any>(
    id: SubagentHandle<TResult>,
    signal?: AbortSignal,
  ): Promise<SubagentResult<TResult>> {
    const stopIfActive = (): boolean => {
      const snapshot = this.runtime.snapshot(id) as
        | RuntimeSnapshot<TResult>
        | undefined;
      if (
        !snapshot ||
        ["completed", "failed", "stopped"].includes(snapshot.status)
      ) {
        return false;
      }
      this.runtime.stop(id);
      return true;
    };

    let stopped = signal?.aborted === true && stopIfActive();
    const abort = () => {
      try {
        stopped = stopIfActive() || stopped;
      } catch {
        // The worker may have completed between its snapshot and stop call.
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const snapshot = (await this.runtime.wait(
        id,
      )) as RuntimeSnapshot<TResult>;
      const runtime = toAgentSnapshot(snapshot);
      if (snapshot.status === "completed") {
        return {
          status: "completed",
          result: snapshot.result as TResult,
          runtime,
        };
      }
      return {
        status: snapshot.status === "stopped" || stopped ? "stopped" : "failed",
        error:
          snapshot.error ??
          (stopped ? "Stopped by user." : `Subagent ${snapshot.status}.`),
        runtime,
      };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
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
