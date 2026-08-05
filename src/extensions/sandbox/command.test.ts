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
  writeMode?: "workspace-write" | "repository-read-only";
}) {
  initTheme("dark");
  const state = createSandboxSessionState();
  state.reset(
    options.unavailable ? undefined : policy,
    "initialization failed",
    options.writeMode,
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
  return { done, panel, requestRender, notify, state, denials };
}

function moveDown(panel: SandboxPanel, count = 1): void {
  for (let index = 0; index < count; index += 1) {
    panel.handleInput("\x1b[B");
  }
}

function select(panel: SandboxPanel): void {
  panel.handleInput("\r");
}

describe("Sandbox command", () => {
  it("uses a quiet selectable main menu with the approved rows", () => {
    const { panel } = panelFixture({ supportedMac: true });
    const rendered = panel.render(120).join("\n");

    expect(rendered).toContain("Mode");
    expect(rendered).toContain("Confirmed denials");
    expect(rendered).toContain("Policy details");
    expect(rendered).not.toContain("Type to search");
    expect(rendered).not.toContain("navigate");
    expect(rendered).not.toContain("? help");
    panel.dispose();
  });

  it("renders newest denials as a wide list and opens labeled direct and Bash details", () => {
    const fixture = panelFixture({ supportedMac: true });
    fixture.denials.recordDirect({
      tool: "write",
      requestedPath: "outside.ts",
      target: "/outside.ts",
      reason: "outside workspace",
    });
    fixture.denials.recordBash({
      process: "node",
      pid: 42,
      operation: "file-write-create",
      path: "/workspace/generated/file.ts",
    });

    moveDown(fixture.panel);
    select(fixture.panel);
    const rows = fixture.panel.render(120).join("\n");
    expect(rows).toContain("bash/node");
    expect(rows).toContain("file-write-create");
    expect(rows).toContain("generated/file.ts");
    expect(rows.indexOf("bash/node")).toBeLessThan(
      rows.indexOf("direct/write"),
    );

    select(fixture.panel);
    const bashDetail = fixture.panel.render(120).join("\n");
    expect(bashDetail).toContain("Time:");
    expect(bashDetail).toContain("Process: node");
    expect(bashDetail).toContain("PID: 42");
    expect(bashDetail).toContain("Operation: file-write-create");
    expect(bashDetail).toContain("Path: /workspace/generated/file.ts");

    fixture.panel.handleInput("\u001b");
    moveDown(fixture.panel);
    select(fixture.panel);
    const directDetail = fixture.panel.render(120).join("\n");
    expect(directDetail).toContain("Requested: outside.ts");
    expect(directDetail).toContain("Resolved: /outside.ts");
    expect(directDetail).toContain("Reason: outside workspace");
    expect(directDetail).not.toContain("{");
    fixture.panel.dispose();
  });

  it("shows effective repository-read-only authority in policy details", () => {
    const fixture = panelFixture({
      supportedMac: true,
      writeMode: "repository-read-only",
    });
    fixture.state.reset(
      {
        ...policy,
        git: {
          worktreeRoot: "/workspace",
          worktreeGitDir: "/workspace/.git",
          commonGitDir: "/git-common",
        },
        dependencyRoots: ["/workspace/node_modules"],
        writableRoots: [
          "/workspace",
          "/workspace/.git",
          "/git-common",
          "/workspace/node_modules",
          "/temporary",
          "/cache",
        ],
      },
      undefined,
      "repository-read-only",
    );

    moveDown(fixture.panel, 2);
    select(fixture.panel);
    const policyDetail = fixture.panel.render(120).join("\n");
    expect(policyDetail).toContain("Mode: on (repository-read-only child)");
    expect(policyDetail).toContain(
      "Direct write/edit scope: repository mutation denied",
    );
    expect(policyDetail).toContain("Bash writable roots: /temporary, /cache");
    expect(policyDetail).not.toContain("/workspace/node_modules");
    fixture.panel.dispose();
  });

  it("refreshes active denial views and unsubscribes once when closed", () => {
    const fixture = panelFixture({ supportedMac: true });
    moveDown(fixture.panel);
    select(fixture.panel);
    const before = fixture.requestRender.mock.calls.length;
    fixture.denials.recordDirect({ tool: "edit", reason: "outside workspace" });
    expect(fixture.requestRender.mock.calls.length).toBeGreaterThan(before);
    expect(fixture.panel.render(120).join("\n")).toContain("direct/edit");

    fixture.panel.handleInput("\u001b");
    fixture.panel.handleInput("\u001b");
    expect(fixture.done).toHaveBeenCalledOnce();
    const afterClose = fixture.requestRender.mock.calls.length;
    fixture.denials.recordDirect({ tool: "write", reason: "later" });
    expect(fixture.requestRender).toHaveBeenCalledTimes(afterClose);
    fixture.panel.dispose();
  });

  it("keeps the displayed mode truthful after rejected changes", () => {
    const fixture = panelFixture({ supportedMac: true, unavailable: true });
    select(fixture.panel);
    expect(fixture.state.enabled()).toBe(false);
    expect(fixture.panel.render(100).join("\n")).toContain("Off");
    select(fixture.panel);
    expect(fixture.state.enabled()).toBe(false);
    expect(fixture.panel.render(100).join("\n")).toContain("Off");
    expect(fixture.notify).toHaveBeenLastCalledWith(
      "sandbox: unavailable; reload to retry initialization",
      "warning",
    );
    moveDown(fixture.panel, 2);
    select(fixture.panel);
    expect(fixture.panel.render(100).join("\n")).toContain(
      "Direct write/edit scope: unrestricted (Sandbox off)",
    );
    fixture.panel.dispose();
  });

  it("keeps direct commands and bounded non-TUI diagnostics truthful", async () => {
    const fixture = commandFixture(true);
    await fixture.handler("", fixture.ctx);
    expect(fixture.custom).toHaveBeenCalledOnce();
    await fixture.handler("off", fixture.ctx);
    expect(fixture.state.enabled()).toBe(false);
    await fixture.handler("on", fixture.ctx);
    expect(fixture.state.enabled()).toBe(true);

    fixture.denials.recordDirect({
      tool: "write",
      requestedPath: "outside.ts",
      target: "/outside.ts",
      reason: "outside workspace",
    });
    fixture.denials.recordBash({
      process: "node",
      pid: 42,
      operation: "file-write-create",
      path: "/private/file",
    });
    expect(sandboxPanelDetail(fixture.state, true, fixture.denials)).toContain(
      "Mode: on",
    );
    expect(sandboxPanelDetail(fixture.state, true, fixture.denials)).toContain(
      "bash node (pid 42)",
    );

    await fixture.handler("", { ...fixture.ctx, mode: "rpc" });
    expect(fixture.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Confirmed denials: 2"),
      "info",
    );

    const unsupported = commandFixture(false);
    await unsupported.handler("on", unsupported.ctx);
    expect(unsupported.notify).toHaveBeenLastCalledWith(
      "sandbox: unavailable on this platform",
      "warning",
    );
  });
});
