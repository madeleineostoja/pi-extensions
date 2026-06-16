import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { RuntimeSnapshot } from "./runtime.js";
import { elapsedLabel } from "./roster.js";
import type { PublicAgentParams } from "./index.js";

type AgentToolDetails = RuntimeSnapshot;
type AgentToolResultWithStatus = AgentToolResult<AgentToolDetails> & {
  isError: boolean;
};

export function toolResult(
  snapshot: RuntimeSnapshot,
  mode: "foreground" | "background" | "status" = "status",
): AgentToolResultWithStatus {
  return {
    content: [{ type: "text", text: resultContent(snapshot, mode) }],
    details: snapshot,
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
  _options: unknown,
  theme: Theme,
): Text {
  const snapshot = result.details;
  if (!isRuntimeSnapshot(snapshot)) {
    return new Text(firstText(result) ?? "(no output)", 0, 0);
  }
  const lines = [
    `${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("accent", snapshot.type)} ${theme.fg(statusColor(snapshot.status), snapshot.status)} ${theme.fg("muted", snapshot.id)}`,
    `elapsed ${elapsedLabel(snapshot)} · tokens ${snapshot.health?.tokensTotal ?? "-"}`,
  ];
  const preview = previewText(
    snapshot.error ?? snapshot.result ?? snapshot.health?.resultPreview,
  );
  if (preview) {
    lines.push(preview);
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
        `Subagent ${snapshot.id} (${snapshot.type}) started in background.`,
        `Status: ${snapshot.status}.`,
        `Use get_subagent_result with id "${snapshot.id}" and wait:true to retrieve the final result.`,
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
  return [
    `Subagent ${snapshot.id} (${snapshot.type}) is ${snapshot.status}.`,
    `Use get_subagent_result with id "${snapshot.id}"${mode === "background" ? " and wait:true" : ""} to retrieve the final result.`,
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
