import type { FilesystemGrant } from "../capabilities.js";
import type { GuardRuntimeState } from "../state.js";
import {
  decideDirectFilesystemTool,
  type DirectFilesystemTool,
} from "./decide.js";

export type FilesystemPromptChoice = "once" | "similar" | "block";

export type FilesystemPrompt = (request: {
  grant: FilesystemGrant;
  outsideBoundary: boolean;
  protectedRead: boolean;
}) => Promise<FilesystemPromptChoice>;

export function filesystemScope(grant: FilesystemGrant): string {
  return grant.kind === "directory" ? `${grant.path}/**` : grant.path;
}

export function filesystemPromptDetail(request: {
  grant: FilesystemGrant;
  outsideBoundary: boolean;
  protectedRead: boolean;
}): string {
  const effects = [
    request.outsideBoundary ? "outside the filesystem boundary" : "",
    request.protectedRead ? "protected explicit read" : "",
  ].filter(Boolean);
  return [
    `Requires: ${effects.join(" and ")}`,
    `Future ${request.grant.access} access: ${filesystemScope(request.grant)}`,
  ].join("\n");
}

export async function gateDirectFilesystemTool(options: {
  tool: DirectFilesystemTool;
  input: Readonly<{ path?: unknown }>;
  cwd: string;
  supportedMac: boolean;
  canPrompt: boolean;
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
  if (!options.canPrompt) {
    return {
      block: true,
      reason:
        "Guard: filesystem approval is unavailable outside interactive TUI.",
    };
  }

  let choice: FilesystemPromptChoice;
  try {
    choice = await options.prompt(decision);
  } catch {
    return {
      block: true,
      reason: "Guard: filesystem approval is unavailable.",
    };
  }
  if (choice === "once") {
    return {};
  }
  if (choice === "similar") {
    options.state.addGrant(decision.grant);
    return {};
  }
  return { block: true, reason: "Guard: filesystem access was blocked." };
}

export function isDirectFilesystemTool(
  toolName: string,
): toolName is DirectFilesystemTool {
  return ["read", "grep", "find", "ls", "write", "edit"].includes(toolName);
}
