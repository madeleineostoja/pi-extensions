import { formatSteer } from "./utils";

export type ToolCallDecision = "pass" | "auto-disable" | "prompt";

export type DecideToolCallParams = {
  readonlyMode: boolean;
  hasUI: boolean;
  toolName: string;
  triggerTools: Set<string>;
};

export function decideToolCall(params: DecideToolCallParams): ToolCallDecision {
  const { readonlyMode, hasUI, toolName, triggerTools } = params;
  if (!readonlyMode) return "pass";
  if (!triggerTools.has(toolName)) return "pass";
  if (!hasUI) return "auto-disable";
  return "prompt";
}

export type ResolveChoiceResult = {
  block: boolean;
  reason?: string;
  sideEffect?: "setEditing";
};

export function resolveChoice(params: {
  choice: string | undefined;
  message: string | undefined;
}): ResolveChoiceResult {
  const { choice, message } = params;
  if (choice === "Accept") {
    return { block: false };
  }
  if (choice === "Accept for this session") {
    return { block: false, sideEffect: "setEditing" };
  }
  return { block: true, reason: formatSteer(message ?? "") };
}
