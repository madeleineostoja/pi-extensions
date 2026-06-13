import type {
  SpawnAgentArgs,
  AgentResult,
  SubagentRuntime,
} from "pi-subagents/runtime";

export type { SpawnAgentArgs, AgentResult };

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

export class DirectSubagentClient implements SubagentClient {
  constructor(private readonly runtime: SubagentRuntime) {}

  async probe(_timeoutMs = 2_000): Promise<ProbeResult> {
    // Direct runtime is always available; return ok immediately.
    return { ok: true, version: 1 };
  }

  async spawn(args: SpawnArgs): Promise<string> {
    return this.runtime.spawn({
      type: args.type,
      prompt: args.prompt,
      description: args.description,
      model: args.model,
      cwd: args.cwd,
      background: true,
      owner: { kind: "pi-implement", role: "worker" },
    });
  }

  async stop(id: string): Promise<void> {
    await this.runtime.stop(id);
  }

  async waitFor(id: string, signal?: AbortSignal): Promise<SubagentResult> {
    const result = await this.runtime.waitFor(id, signal);
    if (result.status === "completed") {
      return { status: "completed", result: result.result };
    }
    return {
      status: result.status === "stopped" ? "stopped" : "failed",
      error: result.error,
    };
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
