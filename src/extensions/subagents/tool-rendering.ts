import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { PublicSubagentResult, RuntimeSnapshot } from "./runtime.js";
import {
  contextUsageLabel,
  costLabel,
  elapsedLabel,
  tokenLabel,
} from "./formatters.js";
import type { PublicAgentParams } from "./public-tools.js";

type AgentToolDetails = RuntimeSnapshot | PublicSubagentResult;
type AgentToolResultWithStatus = AgentToolResult<AgentToolDetails> & {
  isError: boolean;
};

export function toolResult(
  snapshot: RuntimeSnapshot,
  mode: "foreground" | "background" | "status" = "status",
  progress?: string,
): AgentToolResultWithStatus {
  const content = resultContent(snapshot, mode);
  const details = progress === undefined ? snapshot : { snapshot, progress };
  return {
    content: [
      { type: "text", text: progress ? `${content}\n${progress}` : content },
    ],
    details,
    isError: snapshot.status === "failed" || snapshot.status === "stopped",
  } satisfies AgentToolResultWithStatus;
}

export function renderAgentCall(args: PublicAgentParams, theme: Theme): Text {
  const description = args.description ?? previewText(args.prompt, 120) ?? "";
  return new Text(
    `${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("accent", args.subagent_type)} ${theme.fg("muted", description)}`,
    0,
    0,
  );
}

export function renderAgentResult(
  result: AgentToolResult<AgentToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Text {
  const response = result.details;
  const snapshot = isPublicSubagentResult(response)
    ? response.snapshot
    : response;
  if (!isRuntimeSnapshot(snapshot)) {
    return new Text(firstText(result) ?? "(no output)", 0, 0);
  }
  const lines = [
    `${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("accent", snapshot.type)} ${theme.fg(statusColor(snapshot.status), snapshot.status)} ${theme.fg("muted", snapshot.id)}`,
    `elapsed ${elapsedLabel(snapshot)} · context ${contextUsageLabel(snapshot)} · estimated API cost ${costLabel(snapshot.health?.estimatedCost)} · peak ${tokenLabel(snapshot.health?.peakContextTokens)} · cumulative ${tokenLabel(snapshot.health?.tokensTotal)}`,
  ];
  const output = options.expanded
    ? firstText(result)
    : previewText(
        snapshot.error ?? snapshot.result ?? snapshot.health?.resultPreview,
      );
  if (output) {
    lines.push(theme.fg(options.expanded ? "toolOutput" : "dim", output));
  }
  return new Text(lines.join("\n"), 0, 0);
}

function resultContent(
  snapshot: RuntimeSnapshot,
  mode: "foreground" | "background" | "status",
): string {
  if (snapshot.status === "completed") {
    if (mode === "background") {
      return [
        `Subagent ${snapshot.id} (${snapshot.type}) completed after starting in background.`,
        `Use get_subagent_result with id "${snapshot.id}" and wait:true when its result becomes a dependency.`,
      ].join("\n");
    }
    if (mode === "foreground" || mode === "status") {
      return resultText(snapshot.result);
    }
  }
  if (snapshot.status === "failed" || snapshot.status === "stopped") {
    const reason = snapshot.error ?? `${snapshot.status}.`;
    return `Subagent ${snapshot.id} (${snapshot.type}) ${snapshot.status}: ${reason}`;
  }
  if (mode === "background") {
    return [
      `Subagent ${snapshot.id} (${snapshot.type}) is ${snapshot.status} in the background.`,
      "Continue the independent work that justified background mode.",
      `When its result becomes a dependency, use get_subagent_result with id "${snapshot.id}" and wait:true. Do not poll.`,
    ].join("\n");
  }
  return [
    `Subagent ${snapshot.id} (${snapshot.type}) is ${snapshot.status}.`,
    `Use get_subagent_result with id "${snapshot.id}" to retrieve the final result.`,
  ].join("\n");
}

function resultText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstText(result: AgentToolResult<unknown>): string | undefined {
  const part = result.content[0];
  return part?.type === "text" ? part.text : undefined;
}

function previewText(value: unknown, max = 220): string | undefined {
  const text = resultText(value).replace(/\s+/g, " ").trim();
  if (!text) {
    return undefined;
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isPublicSubagentResult(value: unknown): value is PublicSubagentResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "snapshot" in value &&
    isRuntimeSnapshot(value.snapshot)
  );
}

function isRuntimeSnapshot(value: unknown): value is RuntimeSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "status" in value &&
    "type" in value &&
    "timestamps" in value
  );
}

function statusColor(
  status: RuntimeSnapshot["status"],
): "success" | "error" | "warning" | "muted" {
  if (status === "completed") {
    return "success";
  }
  if (status === "failed") {
    return "error";
  }
  if (status === "stopped") {
    return "warning";
  }
  return "muted";
}
