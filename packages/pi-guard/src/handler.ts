import { formatSteer } from "./utils";

export type ToolCallDecision = "pass" | "auto-disable" | "prompt";

export interface DecideToolCallParams {
  guardMode: boolean;
  hasUI: boolean;
  toolName: string;
  triggerTools: Set<string>;
}

export function decideToolCall(params: DecideToolCallParams): ToolCallDecision {
  const { guardMode, hasUI, toolName, triggerTools } = params;
  if (!guardMode) return "pass";
  if (!triggerTools.has(toolName)) return "pass";
  if (!hasUI) return "auto-disable";
  return "prompt";
}

export interface ResolveChoiceResult {
  block: boolean;
  reason?: string;
  sideEffect?: "disable";
}

export function resolveChoice(params: {
  choice: string | undefined;
  message: string | undefined;
}): ResolveChoiceResult {
  const { choice, message } = params;
  if (choice === "Accept") {
    return { block: false };
  }
  if (choice === "Accept and stop guarding") {
    return { block: false, sideEffect: "disable" };
  }
  return { block: true, reason: formatSteer(message ?? "") };
}
