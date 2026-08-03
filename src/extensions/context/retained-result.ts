import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };
type ContentBlock = TextBlock | ImageBlock;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type RetainedResult = {
  content: ContentBlock[];
  details?: Json;
};

type RetainedEnvelope = {
  type: "pipkin.context.retained-result";
  version: 1;
  result: RetainedResult;
};

const RETAINED_KEY = "retainedResult";

export function retainResult(
  result: Readonly<{ content: unknown; details?: unknown }>,
  summary: string,
  toolCallId: string,
  options: Readonly<{ label?: string }> = {},
): { content: TextBlock[]; details: { retainedResult: RetainedEnvelope } } {
  const retained = validateResult(result);
  const label = options.label ?? "Bash";
  if (!/^[\p{L}\p{N} ][\p{L}\p{N} -]{0,79}$/u.test(label)) {
    throw new Error("Invalid retained result label");
  }
  const envelope: RetainedEnvelope = {
    type: "pipkin.context.retained-result",
    version: 1,
    result: retained,
  };
  if (encodedBytes(envelope) > DEFAULT_MAX_BYTES) {
    throw new Error("Invalid retained result");
  }
  return {
    content: [
      {
        type: "text",
        text: `${summary}\nThe ${label} result is retained; call context_recall("${toolCallId}") to inspect it.`,
      },
    ],
    details: { retainedResult: envelope },
  };
}

export function decodeRetainedResult(
  details: unknown,
): RetainedResult | undefined {
  if (!isRecord(details) || !Object.hasOwn(details, RETAINED_KEY)) {
    return undefined;
  }
  const envelope = details[RETAINED_KEY];
  if (
    !isRecord(envelope) ||
    envelope.type !== "pipkin.context.retained-result" ||
    envelope.version !== 1 ||
    !Object.hasOwn(envelope, "result") ||
    encodedBytes(envelope) > DEFAULT_MAX_BYTES
  ) {
    return undefined;
  }
  try {
    return validateResult(envelope.result);
  } catch {
    return undefined;
  }
}

export function hasRetainedResult(details: unknown): boolean {
  return isRecord(details) && Object.hasOwn(details, RETAINED_KEY);
}

function validateResult(value: unknown): RetainedResult {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new Error("Invalid retained result");
  }
  const content = value.content.map(validateContentBlock);
  if (content.length === 0) {
    throw new Error("Invalid retained result");
  }
  const result =
    !Object.hasOwn(value, "details") || value.details === undefined
      ? { content }
      : !isJson(value.details) || jsonBytes(value.details) > DEFAULT_MAX_BYTES
        ? undefined
        : { content, details: value.details };
  if (result === undefined || encodedBytes(result) > DEFAULT_MAX_BYTES) {
    throw new Error("Invalid retained result");
  }
  return result;
}

function validateContentBlock(value: unknown): ContentBlock {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid retained result");
  }
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  ) {
    return { type: "image", data: value.data, mimeType: value.mimeType };
  }
  throw new Error("Invalid retained result");
}

function jsonBytes(value: Json): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function encodedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isJson(value: unknown, ancestors = new Set<object>()): value is Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJson(item, ancestors))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => isJson(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
