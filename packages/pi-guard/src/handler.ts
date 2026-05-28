import { formatBlockReason } from "./utils";

export type GuardDecision = "pass" | "auto-disable" | "prompt";

export type DecideToolCallParams = {
  guardEnabled: boolean;
  hasUI: boolean;
  toolName: string;
};

export function decideToolCall(params: DecideToolCallParams): GuardDecision {
  const { guardEnabled, hasUI, toolName } = params;
  if (!guardEnabled) {
    return "pass";
  }
  if (toolName !== "bash") {
    return "pass";
  }
  if (!hasUI) {
    return "auto-disable";
  }
  return "prompt";
}

export type ResolveChoiceResult = {
  block: boolean;
  reason?: string;
  sideEffect?: "disableGuard" | "allowKey";
};

export function resolveChoice(params: {
  choice: string | undefined;
  message: string | undefined;
}): ResolveChoiceResult {
  const { choice, message } = params;
  if (choice === "Allow once") {
    return { block: false };
  }
  if (choice === "Allow similar this session") {
    return { block: false, sideEffect: "allowKey" };
  }
  if (choice === "Allow all this session") {
    return { block: false, sideEffect: "disableGuard" };
  }
  return { block: true, reason: formatBlockReason(message ?? "") };
}
