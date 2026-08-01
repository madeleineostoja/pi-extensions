import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type ActionPromptUI = Pick<ExtensionUIContext, "select">;

export type ActionPromptResult<T extends string> =
  | { kind: "selected"; value: T }
  | { kind: "aborted" };

export async function promptForAction<T extends string>(options: {
  ui: ActionPromptUI;
  signal?: AbortSignal;
  title: string;
  detail?: string;
  choices: readonly { value: T; label: string }[];
}): Promise<ActionPromptResult<T>> {
  const labels = options.choices.map((choice) => choice.label);
  try {
    const selected = options.signal
      ? await options.ui.select(
          [options.title, options.detail].filter(Boolean).join("\n"),
          labels,
          { signal: options.signal },
        )
      : await options.ui.select(
          [options.title, options.detail].filter(Boolean).join("\n"),
          labels,
        );
    const choice = options.choices[labels.indexOf(selected ?? "")];
    return choice
      ? { kind: "selected", value: choice.value }
      : { kind: "aborted" };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError"
    ) {
      return { kind: "aborted" };
    }
    throw error;
  }
}
