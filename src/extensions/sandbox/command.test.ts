import { describe, expect, it, vi } from "vitest";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  SandboxPanel,
  registerSandboxCommand,
  sandboxPanelDetail,
} from "./command.js";
import { createSandboxDenialRecorder } from "./denials.js";
import { createSandboxSessionState } from "./state.js";

const policy = {
  sessionCwd: "/workspace/subdirectory",
  workspaceRoot: "/workspace",
  temporaryRoots: ["/temporary"],
  cacheRoots: ["/cache"],
  dependencyRoots: [],
  writableRoots: ["/workspace", "/git", "/temporary", "/cache"],
  creationRoots: [],
} as const;

function commandFixture(supportedMac: boolean) {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const state = createSandboxSessionState();
  const denials = createSandboxDenialRecorder();
  state.reset(policy);
  registerSandboxCommand({
    pi: {
      registerCommand(_name: string, command: { handler: typeof handler }) {
        handler = command.handler;
      },
    } as never,
    state,
    denials,
    supportedMac,
  });
  const notify = vi.fn();
  const custom = vi.fn().mockResolvedValue(undefined);
  return {
    ctx: {
      mode: "tui",
      hasUI: true,
      ui: {
        notify,
        custom,
        setStatus: vi.fn(),
        theme: { fg: (_tone: string, text: string) => text },
      },
    },
    handler: handler!,
    notify,
    custom,
    state,
    denials,
  };
}

function panelFixture(options: {
  supportedMac: boolean;
  unavailable?: boolean;
}) {
  initTheme("dark");
  const state = createSandboxSessionState();
  state.reset(
    options.unavailable ? undefined : policy,
    "initialization failed",
  );
  const denials = createSandboxDenialRecorder();
  const done = vi.fn();
  const requestRender = vi.fn();
  const notify = vi.fn();
  const panel = new SandboxPanel({
    tui: { requestRender } as never,
    theme: {
      fg: (_tone: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme,
    done,
    ctx: {
      mode: "tui",
      ui: {
        notify,
        setStatus: vi.fn(),
        theme: { fg: (_tone: string, text: string) => text },
      },
    } as never,
    state,
    denials,
    supportedMac: options.supportedMac,
  });
  return { done, panel, requestRender, state };
}

describe("Sandbox command", () => {
  it("shows truthful direct and Bash scopes plus bounded denial records", () => {
    const state = createSandboxSessionState();
    const denials = createSandboxDenialRecorder();
    state.reset(policy);
    denials.recordDirect({
      tool: "write",
      requestedPath: "outside.ts",
      target: "/outside.ts",
      reason: "outside workspace",
    });
    denials.recordBash({
      process: "node",
      pid: 42,
      operation: "file-write-create",
      path: "/private/file",
    });

    expect(sandboxPanelDetail(state, true, denials)).toBe(
      "State: on\n" +
        "Direct write/edit scope: /workspace\n" +
        "Sandbox Bash write scopes:\n  /workspace\n  /git\n  /temporary\n  /cache\n" +
        "Confirmed denials: 2\nRecent denials:\n" +
        "direct write · requested outside.ts · target /outside.ts · outside workspace\n" +
        "bash node (pid 42) · file-write-create · /private/file",
    );
  });

  it("opens only a TUI custom panel and reports a bounded non-TUI fallback", async () => {
    const fixture = commandFixture(true);
    await fixture.handler("", fixture.ctx);
    expect(fixture.custom).toHaveBeenCalledOnce();

    await fixture.handler("", { ...fixture.ctx, mode: "rpc" });
    expect(fixture.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("State: on"),
      "info",
    );
  });

  it("changes supported mode directly and rejects unavailable enabling", async () => {
    const fixture = commandFixture(true);
    await fixture.handler("off", fixture.ctx);
    expect(fixture.state.enabled()).toBe(false);
    await fixture.handler("on", fixture.ctx);
    expect(fixture.state.enabled()).toBe(true);

    const unsupported = commandFixture(false);
    await unsupported.handler("on", unsupported.ctx);
    expect(unsupported.notify).toHaveBeenLastCalledWith(
      "sandbox: unavailable on this platform",
      "warning",
    );
  });

  it("closes every panel once without relying on SettingsList", () => {
    for (const fixture of [
      panelFixture({ supportedMac: true }),
      panelFixture({ supportedMac: false }),
      panelFixture({ supportedMac: true, unavailable: true }),
    ]) {
      fixture.panel.handleInput("\u001b");
      fixture.panel.handleInput("\u001b");
      expect(fixture.done).toHaveBeenCalledOnce();
      fixture.panel.dispose();
    }
  });

  it("shows unavailable initialization truthfully and lets supported macOS turn it off", () => {
    const fixture = panelFixture({ supportedMac: true, unavailable: true });

    expect(fixture.panel.render(100).join("\n")).toContain(
      "State: unavailable",
    );
    fixture.panel.handleInput("\r");

    expect(fixture.state.enabled()).toBe(false);
    expect(fixture.panel.render(100).join("\n")).toContain("State: off");
    fixture.panel.dispose();
  });

  it("keeps the setting truthful after a rejected enable and renders SettingsList input", () => {
    const fixture = panelFixture({ supportedMac: true, unavailable: true });
    fixture.panel.handleInput("\r");
    expect(fixture.state.enabled()).toBe(false);
    fixture.panel.handleInput("\r");

    expect(fixture.state.enabled()).toBe(false);
    expect(fixture.panel.render(100).join("\n")).toContain("off");
    expect(fixture.requestRender).toHaveBeenCalled();
    fixture.panel.dispose();
  });
});
