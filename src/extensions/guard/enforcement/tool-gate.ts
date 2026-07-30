import type { PiPathCompatibility } from "../capabilities.js";
import type { GuardRuntimeState } from "../state.js";
import {
  decideDirectFilesystemTool,
  type DirectFilesystemDecision,
  type DirectFilesystemTool,
} from "./decide.js";

export type FilesystemPromptChoice = "once" | "block";
export type FilesystemPromptRequest = Extract<
  DirectFilesystemDecision,
  { kind: "approval-required" }
>;
export type FilesystemPrompt = (
  request: FilesystemPromptRequest,
) => Promise<FilesystemPromptChoice>;

export function filesystemPromptDetail(
  request: FilesystemPromptRequest,
): string {
  const effects = [
    request.outsideSandbox ? "outside the filesystem sandbox" : "",
    request.protectedRead ? "protected explicit read" : "",
  ].filter(Boolean);
  return [
    `Requires: ${effects.join(" and ")}`,
    `Access: ${request.access} ${request.target}`,
  ].join("\n");
}

export async function gateDirectFilesystemTool(options: {
  tool: DirectFilesystemTool;
  input: Readonly<{ path?: unknown }>;
  cwd: string;
  supportedMac: boolean;
  pathCompatibility?: PiPathCompatibility;
  canPrompt: boolean;
  signal?: AbortSignal;
  state: GuardRuntimeState;
  prompt: FilesystemPrompt;
}): Promise<{ block?: boolean; reason?: string }> {
  const decision = decideDirectFilesystemTool(options);
  if (decision.kind === "allow") {
    return {};
  }
  if (decision.kind === "deny") {
    return { block: true, reason: decision.reason };
  }
  if (!options.state.fixedCapabilities()) {
    return {
      block: true,
      reason:
        "Guard: filesystem approval is unavailable outside an active session.",
    };
  }
  if (!options.canPrompt) {
    return {
      block: true,
      reason:
        "Guard: filesystem approval is unavailable outside interactive TUI.",
    };
  }

  const generation = options.state.generation();
  let choice: FilesystemPromptChoice;
  try {
    choice = await options.prompt(decision);
  } catch {
    return {
      block: true,
      reason: "Guard: filesystem approval is unavailable.",
    };
  }
  if (options.signal?.aborted || options.state.generation() !== generation) {
    return {
      block: true,
      reason: "Guard: filesystem approval is no longer active.",
    };
  }
  return choice === "once"
    ? {}
    : { block: true, reason: "Guard: filesystem access was blocked." };
}

export function isDirectFilesystemTool(
  toolName: string,
): toolName is DirectFilesystemTool {
  return ["read", "grep", "find", "ls", "write", "edit"].includes(toolName);
}
