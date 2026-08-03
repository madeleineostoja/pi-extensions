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
    format: Type.Optional(
      StringEnum(["markdown", "html", "text", "json", "raw"] as const),
    ),
    maxChars: Type.Optional(
      Type.Integer({ minimum: 1, maximum: LIMITS.maxChars }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({ minimum: 1_000, maximum: LIMITS.maxTimeoutMs }),
    ),
    removeImages: Type.Optional(Type.Boolean()),
    includeReplies: Type.Optional(
      Type.Union([Type.Boolean(), StringEnum(["extractors"] as const)]),
    ),
  },
  { additionalProperties: false },
);
export type WebFetchInput = Static<typeof WebFetchParameters>;
export type NormalizedWebFetchInput = Required<WebFetchInput>;

export function normalizeInput(input: WebFetchInput): NormalizedWebFetchInput {
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
    format: input.format ?? "markdown",
    maxChars: input.maxChars ?? LIMITS.defaultMaxChars,
    timeoutMs: input.timeoutMs ?? LIMITS.defaultTimeoutMs,
    removeImages: input.removeImages ?? true,
    includeReplies: input.includeReplies ?? "extractors",
  };
}
