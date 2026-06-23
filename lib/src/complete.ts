import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Models,
  SimpleStreamOptions,
  StopReason,
} from "@earendil-works/pi-ai";

type CompleteSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export type CompleteTextDeps =
  | { models?: Models; completeSimple?: never }
  | { completeSimple?: CompleteSimple; models?: never };

export type CompleteTextResult =
  | { ok: true; text: string; stopReason: StopReason }
  | {
      ok: false;
      reason: "aborted" | "error" | "empty" | "length";
      message?: string;
      text?: string;
    };

let cachedModels: Models | undefined;

export async function completeText(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  deps?: CompleteTextDeps,
): Promise<CompleteTextResult> {
  try {
    const response = deps?.completeSimple
      ? await deps.completeSimple(model, context, options)
      : await getModels(deps).completeSimple(model, context, options);
    return completionResult(response);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: "aborted" };
    }
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function getModels(deps?: CompleteTextDeps): Models {
  if (deps?.models) {
    return deps.models;
  }
  cachedModels ??= builtinModels();
  return cachedModels;
}

function completionResult(response: AssistantMessage): CompleteTextResult {
  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  if (response.stopReason === "aborted") {
    return { ok: false, reason: "aborted", text };
  }
  if (response.stopReason === "error") {
    return {
      ok: false,
      reason: "error",
      message: response.errorMessage || "Provider returned an error",
      text,
    };
  }
  if (text.trim()) {
    return { ok: true, text, stopReason: response.stopReason };
  }
  if (response.stopReason === "length") {
    return { ok: false, reason: "length", text };
  }
  return { ok: false, reason: "empty", text };
}
