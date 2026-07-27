import { completeSimple as defaultCompleteSimple } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StopReason,
} from "@earendil-works/pi-ai";

type CompleteSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export type CompleteTextDeps = { completeSimple?: CompleteSimple };

export type CompleteTextResult =
  | { ok: true; text: string; stopReason: StopReason }
  | {
      ok: false;
      reason: "aborted" | "error" | "empty" | "length";
      message?: string;
      text?: string;
    };

export async function completeText(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  deps?: CompleteTextDeps,
): Promise<CompleteTextResult> {
  try {
    const response = await (deps?.completeSimple ?? defaultCompleteSimple)(
      model,
      context,
      options,
    );
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
