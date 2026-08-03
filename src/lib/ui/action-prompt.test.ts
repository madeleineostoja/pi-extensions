import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { promptForAction } from "./action-prompt.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

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
      const component = factory({} as never, theme, {} as never, done);
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

  it("settles a rich prompt once when Escape and disposal race", async () => {
    const done = vi.fn();
    const custom = vi.fn((factory) => {
      const component = factory({} as never, theme, {} as never, done);
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
      factory({} as never, theme, {} as never, done);
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
