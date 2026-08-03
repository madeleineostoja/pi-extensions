import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getSubagentRuntime } from "#subagents/runtime";
import type { ImplementWorkerRole, RuntimeSnapshot } from "#subagents/runtime";
import type { ModelPreset, ThinkingLevel } from "#lib/config";
import type { Static, TSchema } from "typebox";

export type SubagentHandle<TResult = unknown> = string & {
  readonly __subagentResult?: TResult;
};

export type SubagentClient = {
  spawn<TSchemaValue extends TSchema = TSchema>(
    args: SpawnArgs<TSchemaValue>,
  ): Promise<SubagentHandle<Static<TSchemaValue>>>;
  stop(id: string): Promise<void>;
  waitFor<TResult = any>(
    id: SubagentHandle<TResult>,
    signal?: AbortSignal,
  ): Promise<SubagentResult<TResult>>;
};

export type PiImplementWorkerRole = ImplementWorkerRole;

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

export type SubagentResult<TResult = any> =
  | { status: "completed"; result: TResult }
  | { status: "failed"; error: string }
  | { status: "stopped"; error: string };

export type ImplementRole = {
  type: string;
  model: string;
  thinking: ThinkingLevel;
};

export type ImplementRoles = {
  implementer: ImplementRole;
  reviewer: ImplementRole;
  planner: ImplementRole;
};

export function resolveImplementRoles(
  models: Readonly<Partial<Record<"medium" | "high", ModelPreset>>>,
): ImplementRoles | undefined {
  const medium = models.medium;
  const high = models.high;
  if (!medium || !high) {
    return undefined;
  }
  return {
    implementer: { type: "pipkin:implement:implementer", ...medium },
    reviewer: { type: "pipkin:implement:reviewer", ...high },
    planner: { type: "pipkin:implement:planner", ...high },
  };
}

const READ_ONLY_TOOLS = [
  "read",
  "bash",
  "bash_outcome",
  "context_recall",
  "grep",
  "find",
  "ls",
  "explore",
  "lsp",
  "record_papercut",
];
const PUBLIC_AGENT_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];
const MUTATING_TOOLS = ["edit", "write", ...PUBLIC_AGENT_TOOLS];

export function mutableWorkerExcludedTools(): string[] {
  return ["inspect_implement_run", ...PUBLIC_AGENT_TOOLS];
}

export function readOnlyWorkerTools(activeTools?: string[]): {
  tools: string[];
  excludeTools: string[];
} {
  const selected = READ_ONLY_TOOLS.filter(
    (name) => activeTools?.includes(name) ?? name !== "lsp",
  );
  const bashActive = selected.includes("bash");
  const recallActive = bashActive && selected.includes("context_recall");
  return {
    tools: selected.filter(
      (name) =>
        (name !== "context_recall" || recallActive) &&
        (name !== "bash_outcome" ||
          (recallActive && selected.includes("bash_outcome"))),
    ),
    excludeTools: MUTATING_TOOLS,
  };
}

export class RuntimeSubagentClient implements SubagentClient {
  private readonly runtime;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionCommandContext,
    private readonly runId: string,
  ) {
    this.runtime = getSubagentRuntime(pi);
  }

  async spawn<TSchemaValue extends TSchema = TSchema>(
    args: SpawnArgs<TSchemaValue>,
  ): Promise<SubagentHandle<Static<TSchemaValue>>> {
    const cwd = args.cwd ?? this.ctx.cwd;
    const role = args.role ?? "implementer";
    const snapshot = await this.runtime.runManagedAgent({
      owner: {
        kind: "pipkin:implement",
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
        ? readOnlyWorkerTools(this.pi.getActiveTools?.())
        : { excludeTools: mutableWorkerExcludedTools() }),
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
      if (snapshot.status === "completed") {
        return {
          status: "completed",
          result: snapshot.result as TResult,
        };
      }
      return {
        status: snapshot.status === "stopped" || stopped ? "stopped" : "failed",
        error:
          snapshot.error ??
          (stopped ? "Stopped by user." : `Subagent ${snapshot.status}.`),
      };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}
