import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  compactDisplayText,
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import type { RuntimeHealth, RuntimeSnapshot } from "./runtime.js";
import { costLabel, elapsedLabel, tokenLabel } from "./formatters.js";
import type { PublicAgentParams } from "./public-tools.js";

type AgentPresentation = "foreground" | "background" | "status" | "steer";
type AgentToolDetails = Pick<
  RuntimeSnapshot,
  "id" | "status" | "type" | "description" | "timestamps"
> & {
  health?: Pick<
    RuntimeHealth,
    "contextUsage" | "estimatedCost" | "peakContextTokens" | "tokensTotal"
  >;
  error?: string;
  presentation: AgentPresentation;
  progress?: string;
};
type AgentToolResultWithStatus = AgentToolResult<AgentToolDetails> & {
  isError: boolean;
};

export function toolResult(
  snapshot: RuntimeSnapshot,
  presentation: AgentPresentation = "status",
  progress?: string,
): AgentToolResultWithStatus {
  const content = resultContent(snapshot, presentation);
  return {
    content: [
      { type: "text", text: progress ? `${content}\n${progress}` : content },
    ],
    details: presentationDetails(snapshot, presentation, progress),
    isError: snapshot.status === "failed" || snapshot.status === "stopped",
  } satisfies AgentToolResultWithStatus;
}

export const renderAgentCall = toolCallRenderer<PublicAgentParams>({
  name: "Agent",
  detail: (args) =>
    `${args.subagent_type} · ${args.description ?? previewText(args.prompt, 120) ?? "subagent"}`,
  pending: "Starting subagent…",
});

export const renderAgentResult = toolResultRenderer({
  summary(result) {
    const details = agentDetails(result);
    return details ? completedSummary(details) : "Subagent result unavailable.";
  },
  partial(result, context) {
    const details = agentDetails(result);
    const presentation = details?.presentation ?? presentationFor(context.args);
    if (!details) {
      const id = retainedId(context.args);
      if (presentation === "status") {
        return id
          ? `Retrieving subagent ${id}…`
          : "Retrieving subagent result…";
      }
      if (presentation === "steer") {
        return id
          ? `Queueing guidance for ${id}…`
          : "Queueing subagent guidance…";
      }
      const submitted = submittedDescription(context.args);
      return submitted ? `Starting ${submitted}…` : "Starting subagent…";
    }
    if (presentation === "background") {
      return backgroundSummary(details);
    }
    if (presentation === "steer") {
      return `Queueing guidance for ${details.id}…`;
    }
    if (presentation === "status") {
      return `Retrieving subagent ${details.id}…`;
    }
    return `Starting ${description(details)}…`;
  },
  error(result, context) {
    const details = agentDetails(result);
    const presentation = details?.presentation ?? presentationFor(context.args);
    const id = details?.id ?? retainedId(context.args);
    const reason =
      details?.error ?? resultErrorText(result) ?? "request failed.";
    if (presentation === "status") {
      return `Could not retrieve subagent ${id ?? "result"}: ${reason}`;
    }
    if (presentation === "steer") {
      return `Could not steer subagent ${id ?? "result"}: ${reason}`;
    }
    return `${errorVerb(details)}${id ? ` ${id}` : ""}: ${reason}`;
  },
  content: "markdown",
  expandedContent(result) {
    return agentDetails(result)?.presentation === "background"
      ? []
      : result.content;
  },
});

function completedSummary(details: AgentToolDetails): string | string[] {
  if (details.status !== "completed") {
    if (details.presentation === "background") {
      return backgroundSummary(details);
    }
    if (details.presentation === "steer") {
      return `Guidance queued for subagent ${details.id}.`;
    }
    return `Subagent ${details.id} is ${details.status}.`;
  }
  const sentence =
    details.presentation === "foreground"
      ? `Completed ${description(details)}.`
      : details.presentation === "background"
        ? `Background subagent ${details.id} completed.`
        : details.presentation === "steer"
          ? `Guidance was queued for subagent ${details.id}.`
          : `Retrieved result for ${description(details)}.`;
  const metrics = realMetrics(details);
  return metrics ? [sentence, metrics] : sentence;
}

function backgroundSummary(details: AgentToolDetails): string {
  return `${details.id} · ${details.status} in background`;
}

function realMetrics(
  snapshot: Pick<RuntimeSnapshot, "timestamps" | "health">,
): string | undefined {
  const metrics: string[] = [];
  if (
    hasTimestamp(snapshot.timestamps.startedAt ?? snapshot.timestamps.queuedAt)
  ) {
    metrics.push(`elapsed ${elapsedLabel(snapshot)}`);
  }
  const context = snapshot.health?.contextUsage?.tokens;
  if (finiteNumber(context)) {
    metrics.push(`context ${tokenLabel(context)}`);
  }
  if (finiteNumber(snapshot.health?.estimatedCost)) {
    metrics.push(
      `estimated API cost ${costLabel(snapshot.health.estimatedCost)}`,
    );
  }
  if (finiteNumber(snapshot.health?.peakContextTokens)) {
    metrics.push(`peak ${tokenLabel(snapshot.health.peakContextTokens)}`);
  }
  if (finiteNumber(snapshot.health?.tokensTotal)) {
    metrics.push(`cumulative ${tokenLabel(snapshot.health.tokensTotal)}`);
  }
  return metrics.length > 0 ? metrics.join(" · ") : undefined;
}

function hasTimestamp(value: string | undefined): boolean {
  return value !== undefined && Number.isFinite(Date.parse(value));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function agentDetails(result: {
  details?: unknown;
}): AgentToolDetails | undefined {
  const value = result.details;
  return isAgentToolDetails(value) ? value : undefined;
}

function isAgentToolDetails(value: unknown): value is AgentToolDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "status" in value &&
    "description" in value &&
    "timestamps" in value &&
    "presentation" in value
  );
}

function presentationDetails(
  snapshot: RuntimeSnapshot,
  presentation: AgentPresentation,
  progress?: string,
): AgentToolDetails {
  const health = presentationHealth(snapshot.health);
  const error = compactDisplayText(snapshot.error);
  const boundedProgress = compactDisplayText(progress);
  return {
    id: snapshot.id,
    status: snapshot.status,
    type: snapshot.type,
    description:
      compactDisplayText(snapshot.description) || `${snapshot.type} subagent`,
    timestamps: snapshot.timestamps,
    ...(health ? { health } : {}),
    ...(error ? { error } : {}),
    presentation,
    ...(boundedProgress ? { progress: boundedProgress } : {}),
  };
}

function presentationHealth(
  health: RuntimeSnapshot["health"],
): AgentToolDetails["health"] {
  if (!health) {
    return undefined;
  }
  const result: NonNullable<AgentToolDetails["health"]> = {};
  if (health.contextUsage) {
    result.contextUsage = health.contextUsage;
  }
  if (finiteNumber(health.estimatedCost)) {
    result.estimatedCost = health.estimatedCost;
  }
  if (finiteNumber(health.peakContextTokens)) {
    result.peakContextTokens = health.peakContextTokens;
  }
  if (finiteNumber(health.tokensTotal)) {
    result.tokensTotal = health.tokensTotal;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function description(
  snapshot: Pick<RuntimeSnapshot, "description" | "type">,
): string {
  return snapshot.description || `${snapshot.type} subagent`;
}

function submittedDescription(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }
  const value = args as { description?: unknown; prompt?: unknown };
  if (typeof value.description === "string" && value.description.trim()) {
    return value.description.trim();
  }
  return typeof value.prompt === "string" && value.prompt.trim()
    ? previewText(value.prompt, 120)
    : undefined;
}

function presentationFor(args: unknown): AgentPresentation {
  if (typeof args !== "object" || args === null) {
    return "foreground";
  }
  const value = args as { wait?: unknown; message?: unknown };
  if (typeof value.message === "string") {
    return "steer";
  }
  if ("wait" in value) {
    return "status";
  }
  return "foreground";
}

function retainedId(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }
  const id = (args as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function resultErrorText(result: { content: unknown }): string | undefined {
  if (!Array.isArray(result.content)) {
    return undefined;
  }
  return compactDisplayText(
    result.content
      .flatMap((block) =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
          ? [(block as { text: string }).text]
          : [],
      )
      .join(" "),
  );
}

function errorVerb(
  snapshot: Pick<RuntimeSnapshot, "status"> | undefined,
): string {
  return snapshot?.status === "stopped"
    ? "Subagent stopped"
    : "Subagent failed";
}

function resultContent(
  snapshot: RuntimeSnapshot,
  presentation: AgentPresentation,
): string {
  if (snapshot.status === "completed") {
    if (presentation === "background") {
      return [
        `Subagent ${snapshot.id} (${snapshot.type}) completed after starting in background.`,
        `Use get_subagent_result with id "${snapshot.id}" and wait:true when its result becomes a dependency.`,
      ].join("\n");
    }
    if (presentation === "steer") {
      return `Guidance was queued for subagent ${snapshot.id}.`;
    }
    return resultText(snapshot.result);
  }
  if (snapshot.status === "failed" || snapshot.status === "stopped") {
    const reason = snapshot.error ?? `${snapshot.status}.`;
    return `Subagent ${snapshot.id} (${snapshot.type}) ${snapshot.status}: ${reason}`;
  }
  if (presentation === "background") {
    return [
      `Started subagent ${snapshot.id} (${snapshot.type}) in the background.`,
      "Continue the independent work that justified background mode.",
      `When its result becomes a dependency, use get_subagent_result with id "${snapshot.id}" and wait:true. Do not poll.`,
    ].join("\n");
  }
  if (presentation === "steer") {
    return `Guidance queued for subagent ${snapshot.id}.`;
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

function previewText(value: unknown, max = 220): string | undefined {
  const text = resultText(value).replace(/\s+/g, " ").trim();
  if (!text) {
    return undefined;
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
