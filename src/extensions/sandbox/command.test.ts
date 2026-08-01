import { describe, expect, it, vi } from "vitest";
import { registerSandboxCommand, sandboxPanelDetail } from "./command.js";
import { createSandboxSessionState } from "./state.js";

const policy = {
  sessionCwd: "/workspace/subdirectory",
  workspaceRoot: "/workspace",
  temporaryRoots: ["/temporary"],
  cacheRoots: ["/cache"],
  writableRoots: ["/workspace", "/git", "/temporary", "/cache"],
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
  return {
    ctx: {
      mode: "tui",
      hasUI: true,
      ui: {
        notify,
        select,
        setStatus,
        theme: { fg: (_tone: string, text: string) => text },
      },
    },
    handler: handler!,
    notify,
    select,
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

  it("offers only an unavailable panel and rejects enabling on Linux", async () => {
    const fixture = commandFixture(false);
    fixture.select.mockResolvedValueOnce("Close");
    await fixture.handler("", fixture.ctx);
    expect(fixture.select).toHaveBeenCalledWith(
      expect.stringContaining("Sandbox: sandbox unavailable"),
      ["Close"],
    );
    await fixture.handler("on", fixture.ctx);
    expect(fixture.notify).toHaveBeenLastCalledWith(
      "sandbox: unavailable on this platform",
      "warning",
    );
  });
});
