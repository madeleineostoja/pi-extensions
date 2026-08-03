import { describe, expect, it, vi } from "vitest";
import { registerSandboxCommand, sandboxPanelDetail } from "./command.js";
import { createSandboxSessionState } from "./state.js";

const policy = {
  sessionCwd: "/workspace/subdirectory",
  workspaceRoot: "/workspace",
  temporaryRoots: ["/temporary"],
  cacheRoots: ["/cache"],
  writableRoots: ["/workspace", "/git", "/temporary", "/cache"],
  creationRoots: [],
} as const;

function commandFixture(supportedMac: boolean) {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const state = createSandboxSessionState();
  state.reset(policy);
  registerSandboxCommand({
    pi: {
      registerCommand(_name: string, command: { handler: typeof handler }) {
        handler = command.handler;
      },
    } as never,
    state,
    supportedMac,
  });
  const notify = vi.fn();
  const setStatus = vi.fn();
  const select = vi.fn();
  const custom = vi.fn().mockResolvedValue({ kind: "aborted" });
  return {
    ctx: {
      mode: "tui",
      hasUI: true,
      ui: {
        notify,
        select,
        custom,
        setStatus,
        theme: { fg: (_tone: string, text: string) => text },
      },
    },
    handler: handler!,
    notify,
    select,
    custom,
    setStatus,
    state,
  };
}

describe("Sandbox command", () => {
  it("shows only the changing policy details in its panel", () => {
    const state = createSandboxSessionState();
    state.reset(policy);
    expect(sandboxPanelDetail(state, true)).toBe(
      "State: On\nWorkspace: /workspace\nAdditional writable roots:\n  /git\n  /temporary\n  /cache",
    );
  });

  it("changes supported macOS mode directly and validates arguments", async () => {
    const fixture = commandFixture(true);
    await fixture.handler("off", fixture.ctx);
    expect(fixture.state.enabled()).toBe(false);
    expect(fixture.notify).toHaveBeenLastCalledWith("sandbox: off", "info");
    await fixture.handler("on", fixture.ctx);
    expect(fixture.state.enabled()).toBe(true);
    await fixture.handler("status", fixture.ctx);
    expect(fixture.notify).toHaveBeenLastCalledWith(
      "usage: /sandbox [on|off]",
      "warning",
    );
  });

  it("uses native selection when custom UI is unavailable in RPC mode", async () => {
    const fixture = commandFixture(true);
    fixture.ctx.mode = "rpc";
    fixture.custom.mockResolvedValue(undefined);
    fixture.select
      .mockResolvedValueOnce("Turn off")
      .mockResolvedValueOnce("Close");

    await expect(fixture.handler("", fixture.ctx)).resolves.toBeUndefined();

    expect(fixture.state.enabled()).toBe(false);
    expect(fixture.select).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        "Sandbox: sandbox\n\nState: On\nWorkspace: /workspace",
      ),
      ["Turn off", "Close"],
    );
  });

  it("offers only an unavailable panel and rejects enabling on Linux", async () => {
    const fixture = commandFixture(false);
    await fixture.handler("", fixture.ctx);
    expect(fixture.custom).toHaveBeenCalledOnce();
    await fixture.handler("on", fixture.ctx);
    expect(fixture.notify).toHaveBeenLastCalledWith(
      "sandbox: unavailable on this platform",
      "warning",
    );
  });
});
