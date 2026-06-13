import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSubagentRuntime } from "pi-subagents/runtime";
import { registerImplementCommand } from "./command.js";

const INTERNAL_DEFINITIONS = [
  {
    name: "pi-implement/implementer",
    public: false,
    displayName: "Implementer",
    description: "pi-implement internal implementer worker",
    promptMode: "append" as const,
    systemPrompt:
      "You are an implementation agent. Your job is to implement the given task precisely and completely. You have access to the normal coding tools. Do not spawn additional agents.",
    tools: "all" as const,
    includeExploreTool: true,
    defaultThinking: "high" as const,
    resolveModel: "caller-only" as const,
  },
  {
    name: "pi-implement/reviewer",
    public: false,
    displayName: "Reviewer",
    description: "pi-implement internal reviewer worker",
    promptMode: "append" as const,
    systemPrompt:
      "You are a review agent. Your job is to inspect code changes for correctness, safety, verification, scope, and maintainability. You have access to read-only tools. Do not spawn additional agents.",
    tools: ["read", "bash", "grep", "find", "ls"] as string[],
    includeExploreTool: true,
    defaultThinking: "high" as const,
    resolveModel: "caller-only" as const,
  },
  {
    name: "pi-implement/planner",
    public: false,
    displayName: "Planner",
    description: "pi-implement internal planner worker",
    promptMode: "append" as const,
    systemPrompt:
      "You are a planning agent. Your job is to analyze plans and select implementation strategies. You have access to read-only tools. Do not spawn additional agents.",
    tools: ["read", "bash", "grep", "find", "ls"] as string[],
    includeExploreTool: true,
    defaultThinking: "medium" as const,
    resolveModel: "caller-only" as const,
  },
  {
    name: "pi-implement/self-heal",
    public: false,
    displayName: "Self-heal",
    description: "pi-implement internal self-heal worker",
    promptMode: "append" as const,
    systemPrompt:
      "You are a repair agent. Your job is to diagnose and fix integration or validation failures. You have access to the normal coding tools. Do not spawn additional agents.",
    tools: "all" as const,
    includeExploreTool: true,
    defaultThinking: "high" as const,
    resolveModel: "caller-only" as const,
  },
];

export default function (pi: ExtensionAPI) {
  const runtime = getSubagentRuntime();
  for (const definition of INTERNAL_DEFINITIONS) {
    const result = runtime.registerDefinition(definition);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[pi-implement] ${result.reason}`);
    }
  }
  registerImplementCommand(pi);
}
