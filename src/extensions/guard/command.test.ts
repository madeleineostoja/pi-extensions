import { describe, expect, it, vi } from "vitest";
import { guardMenuDetail, registerGuardCommand } from "./command.js";
import { createGuardRuntimeState } from "./state.js";

function state() {
  return createGuardRuntimeState();
}

describe("Guard menu", () => {
  it("reports managed sandbox health", () => {
    const runtime = state();
    runtime.setBackendHealth({ kind: "healthy", path: "/managed/nono" });

    expect(guardMenuDetail(runtime, true)).toContain("Managed Nono");
    expect(guardMenuDetail(runtime, true)).toContain("/managed/nono: healthy");

    runtime.setBackendHealth({ kind: "tools-only", reason: "missing" });
    expect(guardMenuDetail(runtime, true)).toContain("unhealthy");
    expect(guardMenuDetail(runtime, true)).toContain("npm install");
  });

  it("reports unsupported hosts as local", () => {
    expect(guardMenuDetail(state(), false)).toContain("local Bash");
    expect(guardMenuDetail(state(), false)).toContain("sandbox");
  });

  it("shows current toggle states and toggles them when selected", async () => {
    const runtime = state();
    runtime.setBackendHealth({ kind: "healthy", path: "/managed/nono" });
    let handler: ((args: string, ctx: never) => Promise<void>) | undefined;
    const pi = {
      registerCommand: (
        _name: string,
        command: { handler: typeof handler },
      ) => {
        handler = command.handler;
      },
    };
    registerGuardCommand({
      pi: pi as never,
      state: runtime,
      supportedMac: true,
    });

    const select = vi
      .fn()
      .mockResolvedValueOnce("Sandbox on")
      .mockResolvedValueOnce("Semantic guard on")
      .mockResolvedValueOnce("Close");
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        select,
        setStatus: vi.fn(),
        theme: { fg: (_color: string, text: string) => text },
      },
    } as never;

    await handler!("", ctx);

    expect(runtime.boundaryEnabled()).toBe(false);
    expect(runtime.semanticConfirmationEnabled()).toBe(false);
    expect(select.mock.calls[0]![1]).toEqual([
      "Sandbox on",
      "Semantic guard on",
      "Close",
    ]);
    expect(select.mock.calls[1]![1]).toEqual([
      "Sandbox off",
      "Semantic guard on",
      "Close",
    ]);
    expect(select.mock.calls[2]![1]).toEqual([
      "Sandbox off",
      "Semantic guard off",
      "Close",
    ]);
  });
});
