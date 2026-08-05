import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ForegroundInterruptGuard } from "./foreground-interrupt.js";

beforeAll(() => initTheme("dark", false));

describe("ForegroundInterruptGuard", () => {
  it("renders a rich default-safe confirmation before stopping foreground work", async () => {
    let prompt: Component | undefined;
    let finishPrompt: ((value: unknown) => void) | undefined;
    const keybindings = {
      matches: (data: string, binding: string) =>
        (binding === "tui.select.up" && data === "up") ||
        (binding === "tui.select.confirm" && data === "enter") ||
        (binding === "tui.select.cancel" && data === "escape"),
    };
    const ui = {
      setEditorComponent: vi.fn(),
      select: vi.fn(),
      confirm: vi.fn(),
      custom: vi.fn(
        (factory: (...args: any[]) => Component) =>
          new Promise((resolve) => {
            finishPrompt = resolve;
            prompt = factory(
              { requestRender: vi.fn() },
              {
                fg: (_color: string, text: string) => text,
                bold: (text: string) => text,
              },
              keybindings,
              resolve,
            );
          }),
      ),
    };
    const guard = new ForegroundInterruptGuard();
    guard.install({ mode: "tui", hasUI: true, ui } as never);
    const stop = vi.fn();
    let finishRun!: () => void;
    const running = guard.run(
      { type: "Review", description: "Inspect the implementation", stop },
      () =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
    );

    expect(guard.interrupt()).toBe(true);
    await vi.waitFor(() => expect(prompt).toBeDefined());
    expect(prompt!.render(100).join("\n")).toContain(
      "This will stop the foreground subagent:",
    );
    prompt!.handleInput?.("enter");
    await vi.waitFor(() => expect(finishPrompt).toBeDefined());
    expect(stop).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(guard.interrupt()).toBe(true);
    await vi.waitFor(() => expect(ui.custom).toHaveBeenCalledTimes(2));
    prompt!.handleInput?.("up");
    prompt!.handleInput?.("enter");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());

    finishRun();
    await running;
    guard.dispose();
  });
});
