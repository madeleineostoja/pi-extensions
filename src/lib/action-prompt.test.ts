import { describe, expect, it, vi } from "vitest";
import { promptForAction } from "./action-prompt.js";

describe("action prompt", () => {
  it("maps visible labels to stable action values", async () => {
    const select = vi.fn().mockResolvedValue("Turn off");
    await expect(
      promptForAction({
        ui: { select },
        title: "Sandbox: sandbox",
        detail: "Workspace: /workspace",
        choices: [
          { value: "off", label: "Turn off" },
          { value: "close", label: "Close" },
        ],
      }),
    ).resolves.toEqual({ kind: "selected", value: "off" });
    expect(select).toHaveBeenCalledWith(
      "Sandbox: sandbox\nWorkspace: /workspace",
      ["Turn off", "Close"],
    );
  });

  it("treats cancellation and aborts as non-actions", async () => {
    await expect(
      promptForAction({
        ui: { select: async () => undefined },
        title: "Sandbox",
        choices: [{ value: "close", label: "Close" }],
      }),
    ).resolves.toEqual({ kind: "aborted" });
    await expect(
      promptForAction({
        ui: {
          select: async () => {
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          },
        },
        title: "Sandbox",
        choices: [{ value: "close", label: "Close" }],
      }),
    ).resolves.toEqual({ kind: "aborted" });
  });
});
