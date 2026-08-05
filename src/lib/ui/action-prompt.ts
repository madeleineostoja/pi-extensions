import {
  getSelectListTheme,
  keyHint,
  rawKeyHint,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  type SelectItem,
  SelectList,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { Panel } from "./panel.js";

const MAX_ACTION_LENGTH = 160;
const MAX_DETAIL_LENGTH = 16_384;
const CONTROL_PATTERN = /\p{C}/u;

export type ActionPromptUI = Pick<ExtensionUIContext, "select" | "custom">;

export type ActionPromptChoice<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

export type ActionPromptResult<T extends string> =
  | { kind: "selected"; value: T }
  | { kind: "aborted" };

export type PromptForActionOptions<T extends string> = {
  ui: ActionPromptUI;
  signal?: AbortSignal;
  title: string;
  detail?: string;
  choices: readonly ActionPromptChoice<T>[];
  initialValue?: T;
};

function invalidActionText(value: string, limit: number): boolean {
  return !value.trim() || value.length > limit || CONTROL_PATTERN.test(value);
}

export function validateActionPrompt<T extends string>(
  options: PromptForActionOptions<T>,
): void {
  if (invalidActionText(options.title, MAX_ACTION_LENGTH)) {
    throw new TypeError("Action prompt title is invalid");
  }
  if (
    options.detail !== undefined &&
    (!options.detail.trim() || options.detail.length > MAX_DETAIL_LENGTH)
  ) {
    throw new TypeError("Action prompt detail is invalid");
  }
  if (!options.choices.length) {
    throw new TypeError("Action prompt requires a choice");
  }

  const labels = new Set<string>();
  const values = new Set<string>();
  for (const choice of options.choices) {
    if (invalidActionText(choice.label, MAX_ACTION_LENGTH)) {
      throw new TypeError("Action prompt label is invalid");
    }
    if (invalidActionText(choice.value, MAX_ACTION_LENGTH)) {
      throw new TypeError("Action prompt value is invalid");
    }
    if (
      choice.description !== undefined &&
      invalidActionText(choice.description, MAX_DETAIL_LENGTH)
    ) {
      throw new TypeError("Action prompt description is invalid");
    }
    if (labels.has(choice.label) || values.has(choice.value)) {
      throw new TypeError("Action prompt choices must be unique");
    }
    labels.add(choice.label);
    values.add(choice.value);
  }
  if (options.initialValue !== undefined && !values.has(options.initialValue)) {
    throw new TypeError("Action prompt initial value must match a choice");
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

async function promptForNativeAction<T extends string>(
  options: PromptForActionOptions<T>,
  labels: string[],
): Promise<ActionPromptResult<T>> {
  const title = options.detail
    ? `${options.title}\n\n${options.detail}`
    : options.title;
  try {
    const selected = options.signal
      ? await options.ui.select(title, labels, {
          signal: options.signal,
        })
      : await options.ui.select(title, labels);
    const choice = options.choices[labels.indexOf(selected ?? "")];
    return choice
      ? { kind: "selected", value: choice.value }
      : { kind: "aborted" };
  } catch (error) {
    if (isAbortError(error)) {
      return { kind: "aborted" };
    }
    throw error;
  }
}

class ActionPromptComponent implements Component {
  #selectedIndex = 0;

  constructor(
    private readonly panel: Panel,
    private readonly list: SelectList,
    private readonly itemCount: number,
    private readonly pageSize: number,
    initialIndex: number,
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly keybindings: Pick<KeybindingsManager, "matches">,
    private readonly onDispose: () => void,
  ) {
    this.#selectedIndex = initialIndex;
    this.list.setSelectedIndex(initialIndex);
  }

  render(width: number): string[] {
    return this.panel.render(width);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.#setSelectedIndex(
        this.#selectedIndex === 0
          ? this.itemCount - 1
          : this.#selectedIndex - 1,
      );
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.#setSelectedIndex(
        this.#selectedIndex === this.itemCount - 1
          ? 0
          : this.#selectedIndex + 1,
      );
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.#setSelectedIndex(Math.max(0, this.#selectedIndex - this.pageSize));
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.#setSelectedIndex(
        Math.min(this.itemCount - 1, this.#selectedIndex + this.pageSize),
      );
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.list.getSelectedItem();
      if (selected) {
        this.list.onSelect?.(selected);
      }
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.list.onCancel?.();
    }
  }

  invalidate(): void {
    this.panel.invalidate();
  }

  dispose(): void {
    this.onDispose();
  }

  #setSelectedIndex(index: number): void {
    if (index === this.#selectedIndex) {
      return;
    }
    this.#selectedIndex = index;
    this.list.setSelectedIndex(index);
    this.list.invalidate();
    this.tui.requestRender();
  }
}

export async function promptForAction<T extends string>(
  options: PromptForActionOptions<T>,
): Promise<ActionPromptResult<T>> {
  validateActionPrompt(options);
  if (options.signal?.aborted) {
    return { kind: "aborted" };
  }

  const labels = options.choices.map((choice) => choice.label);
  if (!options.detail) {
    return promptForNativeAction(options, labels);
  }

  let removeAbortListener = () => {};
  try {
    const result = await options.ui.custom<ActionPromptResult<T> | undefined>(
      (tui, theme, keybindings, done) => {
        let settled = false;
        const settle = (result: ActionPromptResult<T>) => {
          if (settled) {
            return;
          }
          settled = true;
          removeAbortListener();
          done(result);
        };
        const items: SelectItem[] = options.choices.map((choice) => ({
          value: choice.value,
          label: choice.label,
          description: choice.description,
        }));
        const pageSize = Math.min(items.length, 10);
        const initialIndex = Math.max(
          0,
          options.choices.findIndex(
            (choice) => choice.value === options.initialValue,
          ),
        );
        const list = new SelectList(items, pageSize, getSelectListTheme());
        list.onSelect = (item) => {
          settle({ kind: "selected", value: item.value as T });
        };
        list.onCancel = () => settle({ kind: "aborted" });
        const content = new Container();
        content.addChild(new Text(options.detail!, 0, 0));
        content.addChild(list);
        const component = new ActionPromptComponent(
          new Panel({
            theme,
            title: options.title,
            child: content,
            footer: new Text(
              `${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`,
              0,
              0,
            ),
          }),
          list,
          items.length,
          pageSize,
          initialIndex,
          tui,
          keybindings,
          () => settle({ kind: "aborted" }),
        );
        const abort = () => settle({ kind: "aborted" });
        options.signal?.addEventListener("abort", abort, { once: true });
        removeAbortListener = () =>
          options.signal?.removeEventListener("abort", abort);
        if (options.signal?.aborted) {
          abort();
        }
        return component;
      },
    );
    return result ?? (await promptForNativeAction(options, labels));
  } catch {
    return { kind: "aborted" };
  } finally {
    removeAbortListener();
  }
}
