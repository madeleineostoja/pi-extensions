import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { promptForAction } from "./action-prompt.js";

beforeAll(() => initTheme("dark", false));

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const defaultKeybindings = {
  matches: (data: string, binding: string) =>
    (binding === "tui.select.confirm" && data === "\r") ||
    (binding === "tui.select.cancel" && data === "\x1b"),
};

describe("action prompt", () => {
  it("maps visible native labels to stable action values", async () => {
    const select = vi.fn().mockResolvedValue("Turn off");
    await expect(
      promptForAction({
        ui: { select, custom: vi.fn() },
        title: "Sandbox: sandbox",
        choices: [
          { value: "off", label: "Turn off" },
          { value: "close", label: "Close" },
        ],
      }),
    ).resolves.toEqual({ kind: "selected", value: "off" });
    expect(select).toHaveBeenCalledWith("Sandbox: sandbox", [
      "Turn off",
      "Close",
    ]);
  });

  it("rejects invalid or duplicate labels and values before displaying", async () => {
    const select = vi.fn();
    const custom = vi.fn();
    await expect(
      promptForAction({
        ui: { select, custom },
        title: "Sandbox",
        choices: [
          { value: "on", label: "Turn on" },
          { value: "off", label: "Turn on" },
        ],
      }),
    ).rejects.toThrow("unique");
    await expect(
      promptForAction({
        ui: { select, custom },
        title: "Sandbox",
        choices: [{ value: "\n", label: "Close" }],
      }),
    ).rejects.toThrow("value is invalid");
    expect(select).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
  });

  it("falls back to native selection when a rich surface is unavailable", async () => {
    const select = vi.fn().mockResolvedValue("Turn off");
    await expect(
      promptForAction({
        ui: { select, custom: vi.fn().mockResolvedValue(undefined) },
        title: "Sandbox",
        detail: "Workspace: /workspace",
        choices: [{ value: "off", label: "Turn off" }],
      }),
    ).resolves.toEqual({ kind: "selected", value: "off" });
    expect(select).toHaveBeenCalledWith("Sandbox\n\nWorkspace: /workspace", [
      "Turn off",
    ]);
  });

  it("keeps selected rich action values distinct from labels", async () => {
    const done = vi.fn();
    const custom = vi.fn((factory) => {
      const component = factory(
        { requestRender: vi.fn() } as never,
        theme,
        defaultKeybindings as never,
        done,
      );
      component.handleInput?.("\r");
      return Promise.resolve(done.mock.calls[0]![0]);
    });

    await expect(
      promptForAction({
        ui: { select: vi.fn(), custom },
        title: "Sandbox",
        detail: "Workspace: /workspace",
        choices: [{ value: "off", label: "Turn off" }],
      }),
    ).resolves.toEqual({ kind: "selected", value: "off" });
  });

  it("uses injected keybindings and requests rendering after selection changes", async () => {
    const done = vi.fn();
    const requestRender = vi.fn();
    const keybindings = {
      matches: (data: string, binding: string) =>
        (data === "j" && binding === "tui.select.down") ||
        (data === "choose" && binding === "tui.select.confirm"),
    };
    const custom = vi.fn((factory) => {
      const component = factory(
        { requestRender } as never,
        theme,
        keybindings as never,
        done,
      );
      component.handleInput?.("ignored");
      expect(requestRender).not.toHaveBeenCalled();
      component.handleInput?.("j");
      expect(requestRender).toHaveBeenCalledOnce();
      component.handleInput?.("choose");
      return Promise.resolve(done.mock.calls[0]![0]);
    });

    await expect(
      promptForAction({
        ui: { select: vi.fn(), custom },
        title: "Sandbox",
        detail: "Workspace: /workspace",
        choices: [
          { value: "off", label: "Turn off" },
          { value: "close", label: "Close" },
        ],
      }),
    ).resolves.toEqual({ kind: "selected", value: "close" });
  });

  it("settles a rich prompt once when Escape and disposal race", async () => {
    const done = vi.fn();
    const custom = vi.fn((factory) => {
      const component = factory(
        { requestRender: vi.fn() } as never,
        theme,
        defaultKeybindings as never,
        done,
      );
      component.handleInput?.("\x1b");
      component.dispose?.();
      return Promise.resolve(done.mock.calls[0]![0]);
    });

    await expect(
      promptForAction({
        ui: { select: vi.fn(), custom },
        title: "Sandbox",
        detail: "Workspace: /workspace",
        choices: [{ value: "close", label: "Close" }],
      }),
    ).resolves.toEqual({ kind: "aborted" });
    expect(done).toHaveBeenCalledOnce();
  });

  it("settles a rich prompt when its signal aborts", async () => {
    const controller = new AbortController();
    const done = vi.fn();
    const custom = vi.fn((factory) => {
      factory(
        { requestRender: vi.fn() } as never,
        theme,
        defaultKeybindings as never,
        done,
      );
      controller.abort();
      return Promise.resolve(done.mock.calls[0]![0]);
    });

    await expect(
      promptForAction({
        ui: { select: vi.fn(), custom },
        signal: controller.signal,
        title: "Sandbox",
        detail: "Workspace: /workspace",
        choices: [{ value: "close", label: "Close" }],
      }),
    ).resolves.toEqual({ kind: "aborted" });
    expect(done).toHaveBeenCalledOnce();
  });
});
