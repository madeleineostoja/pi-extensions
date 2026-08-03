import { describe, expect, it, vi } from "vitest";
import {
  clearPipkinStatus,
  parsePipkinStatusKey,
  pipkinStatusKey,
  setPipkinStatus,
} from "./status.js";

describe("Pipkin status capability", () => {
  it("validates, namespaces, and styles status updates immediately", () => {
    const setStatus = vi.fn();
    const ui = {
      setStatus,
      theme: {
        fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>`,
      },
    };

    setPipkinStatus(ui as never, {
      id: "sandbox",
      priority: 100,
      icon: "󰒃",
      state: "normal",
      text: "sandbox",
    });

    expect(setStatus).toHaveBeenLastCalledWith(
      "pipkin:status:0100:sandbox",
      "<success>󰒃</success> <muted>sandbox</muted>",
    );
    clearPipkinStatus(ui as never, "sandbox", 100);
    expect(setStatus).toHaveBeenLastCalledWith(
      "pipkin:status:0100:sandbox",
      undefined,
    );
  });

  it("rejects invalid producer input and parses only ordered keys", () => {
    expect(() => pipkinStatusKey("Sandbox", 100)).toThrow("ID is invalid");
    expect(() =>
      setPipkinStatus(
        {
          setStatus: vi.fn(),
          theme: { fg: (_tone: string, text: string) => text },
        } as never,
        {
          id: "sandbox",
          priority: 100,
          icon: "x",
          state: "warning",
          text: "sandbox\nwarning",
        },
      ),
    ).toThrow();
    expect(parsePipkinStatusKey("pipkin:status:0100:sandbox")).toEqual({
      priority: 100,
      id: "sandbox",
    });
    expect(parsePipkinStatusKey("pipkin.sandbox")).toBeUndefined();
  });
});
