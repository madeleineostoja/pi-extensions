import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type PermissionPromptUI = Pick<ExtensionUIContext, "select" | "input">;

export type PermissionPromptChoice<T extends string> = {
  value: T;
  label: string;
  input?: {
    title: string;
    placeholder?: string;
  };
};

export type PermissionPromptResult<T extends string> =
  | { kind: "selected"; value: T; message?: string }
  | { kind: "aborted" };

export type PromptForPermissionOptions<T extends string> = {
  ui: PermissionPromptUI;
  signal?: AbortSignal;
  title: string;
  detail?: string;
  choices: readonly PermissionPromptChoice<T>[];
};

export async function promptForPermission<T extends string>(
  options: PromptForPermissionOptions<T>,
): Promise<PermissionPromptResult<T>> {
  const promptText = [options.title, options.detail].filter(Boolean).join("\n");
  const labels = options.choices.map((choice) => choice.label);

  try {
    const selectedLabel = options.signal
      ? await options.ui.select(promptText, labels, { signal: options.signal })
      : await options.ui.select(promptText, labels);

    if (selectedLabel === undefined) {
      return { kind: "aborted" };
    }

    const selectedChoice = options.choices[labels.indexOf(selectedLabel)];
    if (!selectedChoice) {
      return { kind: "aborted" };
    }

    if (!selectedChoice.input) {
      return { kind: "selected", value: selectedChoice.value };
    }

    const message =
      (await options.ui.input(
        selectedChoice.input.title,
        selectedChoice.input.placeholder,
      )) ?? "";

    return { kind: "selected", value: selectedChoice.value, message };
  } catch (err) {
    if (isAbortError(err)) {
      return { kind: "aborted" };
    }
    throw err;
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    err.name === "AbortError"
  );
}
