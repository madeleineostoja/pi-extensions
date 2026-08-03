import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { promptForAction, type ActionPromptUI } from "./ui/action-prompt.js";

export type PermissionPromptUI = ActionPromptUI &
  Pick<ExtensionUIContext, "input">;

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
  const result = await promptForAction(options);
  if (result.kind === "aborted") {
    return result;
  }
  const selectedChoice = options.choices.find(
    (choice) => choice.value === result.value,
  );
  if (!selectedChoice?.input) {
    return result;
  }
  try {
    const message =
      (await options.ui.input(
        selectedChoice.input.title,
        selectedChoice.input.placeholder,
      )) ?? "";
    return { ...result, message };
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
