import {
  CustomEditor,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

type ForegroundRun = {
  type: string;
  description: string;
  stop: () => void;
};

class ForegroundInterruptEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    private appKeybindings: KeybindingsManager,
    private guard: ForegroundInterruptGuard,
  ) {
    super(tui, theme, appKeybindings);
  }

  override handleInput(data: string): void {
    if (
      this.appKeybindings.matches(data, "app.interrupt") &&
      !this.isShowingAutocomplete() &&
      this.guard.interrupt()
    ) {
      return;
    }
    super.handleInput(data);
  }
}

export class ForegroundInterruptGuard {
  #active = new Map<symbol, ForegroundRun>();
  #confirmation: AbortController | undefined;
  #confirming = false;
  #ctx: ExtensionContext | undefined;

  install(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      return;
    }
    this.#ctx = ctx;
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new ForegroundInterruptEditor(tui, theme, keybindings, this),
    );
  }

  async run<T>(run: ForegroundRun, task: () => Promise<T>): Promise<T> {
    const token = Symbol();
    this.#active.set(token, run);
    try {
      return await task();
    } finally {
      this.#active.delete(token);
      if (this.#active.size === 0) {
        this.#confirmation?.abort();
      }
    }
  }

  interrupt(): boolean {
    if (this.#active.size === 0) {
      return false;
    }
    if (this.#confirming) {
      return true;
    }
    const ctx = this.#ctx;
    if (!ctx) {
      return false;
    }

    const runs = [...this.#active.values()];
    const controller = new AbortController();
    this.#confirmation = controller;
    this.#confirming = true;

    void ctx.ui
      .confirm(this.#title(runs.length), this.#message(runs), {
        signal: controller.signal,
      })
      .then((confirmed) => {
        if (confirmed) {
          for (const run of runs) {
            run.stop();
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (this.#confirmation === controller) {
          this.#confirmation = undefined;
          this.#confirming = false;
        }
      });

    return true;
  }

  dispose(): void {
    this.#active.clear();
    this.#confirmation?.abort();
    this.#confirmation = undefined;
    this.#confirming = false;
    this.#ctx = undefined;
  }

  #title(count: number): string {
    return count === 1
      ? "Stop foreground subagent?"
      : `Stop ${count} foreground subagents?`;
  }

  #message(runs: ForegroundRun[]): string {
    const target =
      runs.length === 1
        ? "This will stop the foreground subagent:"
        : "This will stop all foreground subagents in the current turn:";
    return [
      target,
      "",
      ...runs.map((run) => `• ${run.type}: ${run.description}`),
      "",
      "Background subagents will keep running.",
    ].join("\n");
  }
}
