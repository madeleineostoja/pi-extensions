import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { LIMITS } from "./constants.js";
import { WebError } from "./errors.js";

export const WebFetchParameters = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: LIMITS.urlChars,
      description: "Public credential-free HTTP(S) URL to retrieve.",
    }),
    raw: Type.Optional(
      Type.Boolean({
        description:
          "Save the untouched textual response as a temporary artifact instead of returning automatically detected readable content.",
      }),
    ),
    maxChars: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: LIMITS.maxChars,
        description: "Maximum model-visible content characters.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1_000,
        maximum: LIMITS.maxTimeoutMs,
        description: "Request deadline in milliseconds.",
      }),
    ),
    removeImages: Type.Optional(
      Type.Boolean({
        description: "Remove images when extracting readable HTML.",
      }),
    ),
    includeReplies: Type.Optional(
      Type.Union([Type.Boolean(), StringEnum(["extractors"] as const)], {
        description: "Include replies when supported by the HTML extractor.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type WebFetchInput = Static<typeof WebFetchParameters>;
export type NormalizedWebFetchInput = Required<WebFetchInput>;

export const BatchWebFetchParameters = Type.Object(
  {
    requests: Type.Array(WebFetchParameters, {
      minItems: 1,
      maxItems: LIMITS.batchItems,
      description: "One to eight public Web Fetch requests.",
    }),
  },
  { additionalProperties: false },
);
export type BatchWebFetchInput = Static<typeof BatchWebFetchParameters>;

export function normalizeInput(input: WebFetchInput): NormalizedWebFetchInput {
  assertInputShape(input);
  const url = input.url.trim();
  if (
    !url ||
    Array.from(url).length > LIMITS.urlChars ||
    [...url].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  ) {
    throw new WebError(
      "target",
      "Web Fetch URL must be a bounded non-empty URL.",
    );
  }
  return {
    url,
    raw: input.raw ?? false,
    maxChars: input.maxChars ?? LIMITS.defaultMaxChars,
    timeoutMs: input.timeoutMs ?? LIMITS.defaultTimeoutMs,
    removeImages: input.removeImages ?? true,
    includeReplies: input.includeReplies ?? "extractors",
  };
}

export function normalizeBatchInput(
  input: BatchWebFetchInput,
): NormalizedWebFetchInput[] {
  if (
    !isRecord(input) ||
    !hasOnly(input, ["requests"]) ||
    !Array.isArray(input.requests) ||
    input.requests.length < 1 ||
    input.requests.length > LIMITS.batchItems
  ) {
    throw new WebError(
      "content",
      "Batch Web Fetch requires one to eight valid requests.",
    );
  }
  return input.requests.map((request) => normalizeInput(request));
}

function assertInputShape(input: WebFetchInput): void {
  if (
    !isRecord(input) ||
    !hasOnly(input, [
      "url",
      "raw",
      "maxChars",
      "timeoutMs",
      "removeImages",
      "includeReplies",
    ]) ||
    typeof input.url !== "string" ||
    (input.raw !== undefined && typeof input.raw !== "boolean") ||
    (input.maxChars !== undefined &&
      (!Number.isInteger(input.maxChars) ||
        input.maxChars < 1 ||
        input.maxChars > LIMITS.maxChars)) ||
    (input.timeoutMs !== undefined &&
      (!Number.isInteger(input.timeoutMs) ||
        input.timeoutMs < 1_000 ||
        input.timeoutMs > LIMITS.maxTimeoutMs)) ||
    (input.removeImages !== undefined &&
      typeof input.removeImages !== "boolean") ||
    (input.includeReplies !== undefined &&
      typeof input.includeReplies !== "boolean" &&
      input.includeReplies !== "extractors")
  ) {
    throw new WebError("content", "Web Fetch request has an invalid schema.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnly(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
