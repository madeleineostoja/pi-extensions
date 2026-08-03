import type { RuntimeSnapshot } from "./runtime.js";

export const INSPECTION_RECORD_LIMIT = 100;
export const INSPECTION_TEXT_LIMIT_BYTES = 2048;

export type InspectionMessage = {
  role: string;
  timestamp?: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
};

export type InspectionToolArguments = Readonly<
  Record<string, string | number | boolean>
>;

export type InspectionActivity =
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      status: "running" | "completed" | "failed" | "interrupted";
      arguments?: InspectionToolArguments;
      result?: string;
      error?: string;
      timestamp?: string;
    }
  | {
      kind: "compaction";
      status: "running" | "completed" | "failed" | "aborted";
      reason?: string;
      willRetry?: boolean;
      error?: string;
      timestamp: string;
    }
  | {
      kind: "retry";
      status: "scheduled" | "running" | "completed" | "failed";
      error?: string;
      timestamp: string;
    }
  | {
      kind: "steering";
      status: "queued" | "delivered" | "failed" | "discarded";
      text: string;
      error?: string;
      timestamp: string;
    };

export type InspectionRecord =
  | {
      kind: "message";
      role: "user" | "assistant" | "final";
      text: string;
      timestamp?: string;
    }
  | InspectionActivity;

export type RuntimeInspection = {
  snapshot: RuntimeSnapshot;
  messages: readonly InspectionMessage[];
  activity: readonly InspectionActivity[];
  records: readonly InspectionRecord[];
  omittedMessages: number;
  omittedActivity: number;
  compactedHistory: boolean;
};

export function truncateUtf8(
  value: string,
  maxBytes = INSPECTION_TEXT_LIMIT_BYTES,
): string {
  const encoded = Buffer.from(value);
  if (encoded.length <= maxBytes) {
    return value;
  }
  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix);
  if (maxBytes < suffixBytes) {
    return ".".repeat(Math.max(0, maxBytes));
  }
  let end = maxBytes - suffixBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return `${encoded.subarray(0, end).toString("utf8")}${suffix}`;
}

export function immutableInspection(
  inspection: RuntimeInspection,
): RuntimeInspection {
  return Object.freeze({
    ...inspection,
    snapshot: freezeValue(inspection.snapshot),
    messages: Object.freeze(inspection.messages.map(freezeValue)),
    activity: Object.freeze(inspection.activity.map(freezeValue)),
    records: Object.freeze(inspection.records.map(freezeValue)),
  });
}

export function chronologicalInspectionRecords(
  messages: readonly InspectionMessage[],
  activity: readonly InspectionActivity[],
): InspectionRecord[] {
  const records: InspectionRecord[] = [
    ...messages.flatMap((message) => {
      if (
        !message.text ||
        !["user", "assistant", "final"].includes(message.role)
      ) {
        return [];
      }
      return [
        {
          kind: "message" as const,
          role: message.role as "user" | "assistant" | "final",
          text: message.text,
          ...(message.timestamp === undefined
            ? {}
            : { timestamp: message.timestamp }),
        },
      ];
    }),
    ...activity,
  ];
  return records
    .map((record, index) => ({ record, index }))
    .sort(
      (left, right) =>
        (left.record.timestamp ?? "").localeCompare(
          right.record.timestamp ?? "",
        ) || left.index - right.index,
    )
    .map(({ record }) => record);
}

export function projectMessages(messages: readonly unknown[]): {
  messages: InspectionMessage[];
  activity: InspectionActivity[];
  omittedMessages: number;
  omittedActivity: number;
} {
  const projected: InspectionMessage[] = [];
  const activity: InspectionActivity[] = [];
  const calls = new Map<string, number>();
  for (const message of messages) {
    if (!isObject(message) || typeof message.role !== "string") {
      continue;
    }
    const timestamp = timestampText(message.timestamp);
    const role = message.role;
    if (role === "toolResult") {
      const toolCallId = stringValue(message.toolCallId);
      const index =
        toolCallId === undefined ? undefined : calls.get(toolCallId);
      const toolName = stringValue(message.toolName);
      const content =
        toolName === "edit" || toolName === "write"
          ? undefined
          : safeText(message.content);
      const interrupted =
        message.isError === true &&
        /\b(aborted|interrupted|cancelled)\b/i.test(content ?? "");
      const error = message.isError === true ? content : undefined;
      if (index !== undefined) {
        const prior = activity[index];
        if (prior?.kind === "tool") {
          activity[index] = {
            ...prior,
            status:
              message.isError === true
                ? interrupted
                  ? "interrupted"
                  : "failed"
                : "completed",
            ...(content === undefined
              ? {}
              : message.isError === true
                ? { error }
                : { result: content }),
          };
        }
      }
      projected.push({
        role,
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(toolName === undefined ? {} : { toolName }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
        ...(content === undefined ? {} : { text: content }),
      });
      continue;
    }
    const text = messageText(message);
    projected.push({
      role,
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(text === undefined ? {} : { text }),
    });
    if (role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (!isObject(part) || part.type !== "toolCall") {
        continue;
      }
      const toolCallId = stringValue(part.id) ?? stringValue(part.toolCallId);
      const toolName = stringValue(part.name);
      if (!toolCallId || !toolName) {
        continue;
      }
      const argumentsValue = safeToolArguments(
        toolName,
        part.arguments ?? part.params,
      );
      calls.set(toolCallId, activity.length);
      activity.push({
        kind: "tool",
        toolCallId,
        toolName,
        status: "running",
        ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
        ...(timestamp === undefined ? {} : { timestamp }),
      });
    }
  }
  return retain(projected, activity);
}

export function retainActivity(activity: readonly InspectionActivity[]): {
  activity: InspectionActivity[];
  omittedActivity: number;
} {
  const omittedActivity = Math.max(
    0,
    activity.length - INSPECTION_RECORD_LIMIT,
  );
  return {
    activity: activity.slice(-INSPECTION_RECORD_LIMIT),
    omittedActivity,
  };
}

function retain(messages: InspectionMessage[], activity: InspectionActivity[]) {
  const omittedMessages = Math.max(
    0,
    messages.length - INSPECTION_RECORD_LIMIT,
  );
  const retainedActivity = retainActivity(activity);
  return {
    messages: messages.slice(-INSPECTION_RECORD_LIMIT),
    activity: retainedActivity.activity,
    omittedMessages,
    omittedActivity: retainedActivity.omittedActivity,
  };
}

function safeToolArguments(
  name: string,
  value: unknown,
): InspectionToolArguments | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const path = boundedString(value.path) ?? boundedString(value.file_path);
  if (name === "edit" || name === "write") {
    return path === undefined ? undefined : { path };
  }
  if (name === "read") {
    return path === undefined
      ? undefined
      : compactArguments({
          path,
          offset: finiteScalar(value.offset),
          limit: finiteScalar(value.limit),
        });
  }
  if (name === "grep") {
    const pattern = boundedString(value.pattern);
    return pattern === undefined
      ? undefined
      : compactArguments({
          pattern,
          path,
          glob: boundedString(value.glob),
          ignoreCase: booleanValue(value.ignoreCase),
          literal: booleanValue(value.literal),
          context: finiteScalar(value.context),
          limit: finiteScalar(value.limit),
        });
  }
  if (name === "find") {
    const pattern = boundedString(value.pattern);
    return pattern === undefined
      ? undefined
      : compactArguments({
          pattern,
          path,
          limit: finiteScalar(value.limit),
        });
  }
  if (name === "bash") {
    const command = boundedString(value.command);
    return command === undefined
      ? undefined
      : compactArguments({
          command,
          timeout: finiteScalar(value.timeout),
        });
  }
  return undefined;
}

function compactArguments(
  value: Record<string, string | number | boolean | undefined>,
): InspectionToolArguments {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  ) as Record<string, string | number | boolean>;
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" ? truncateUtf8(value) : undefined;
}

function finiteScalar(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function messageText(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (typeof content === "string") {
    return truncateUtf8(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .filter(isObject)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
  return text ? truncateUtf8(text) : undefined;
}

function safeText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return truncateUtf8(value);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .filter(isObject)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
  return text ? truncateUtf8(text) : undefined;
}

function timestampText(value: unknown): string | undefined {
  return typeof value === "number" ? new Date(value).toISOString() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function freezeValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeValue)) as T;
  }
  if (isObject(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, freezeValue(entry)]),
      ),
    ) as T;
  }
  return value;
}
