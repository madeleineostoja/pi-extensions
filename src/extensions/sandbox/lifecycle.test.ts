import { describe, expect, it, vi } from "vitest";
import type { SandboxDenialObserver } from "./denial-observer.js";
import { createSandboxDenialRecorder } from "./denials.js";
import { executeSandboxBash } from "./bash-capability.js";
import { createSandboxSessionController } from "./lifecycle.js";
import type { SandboxPolicy } from "./policy.js";
import { createSandboxSessionState } from "./state.js";

const policy = {
  sessionCwd: "/workspace",
  workspaceRoot: "/workspace",
  temporaryRoots: [],
  cacheRoots: [],
  dependencyRoots: [],
  writableRoots: ["/workspace"],
  creationRoots: [],
} as const;

function context() {
  const statuses = new Map<string, string | undefined>();
  return {
    cwd: "/workspace",
    mode: "tui",
    ui: {
      theme: { fg: (_tone: string, text: string) => text },
      setStatus: (key: string, value: string | undefined) =>
        statuses.set(key, value),
    },
    statuses,
  };
}

function observer() {
  const start = vi.fn();
  const dispose = vi.fn(async () => undefined);
  return {
    dispose,
    start,
    value: {
      start,
      registerBashInvocation: () => () => undefined,
      dispose,
    } satisfies SandboxDenialObserver,
  };
}

function controller(options: {
  state?: ReturnType<typeof createSandboxSessionState>;
  supportedMac: boolean;
  resolvePolicy?: () => Promise<SandboxPolicy>;
  createDenialObserver?: () => SandboxDenialObserver;
}) {
  const state = options.state ?? createSandboxSessionState();
  const denials = createSandboxDenialRecorder();
  const host = {};
  return {
    controller: createSandboxSessionController({
      state,
      denials,
      supportedMac: options.supportedMac,
      host: host as never,
      resolvePolicy: options.resolvePolicy,
      createDenialObserver: options.createDenialObserver
        ? () => options.createDenialObserver!()
        : undefined,
    }),
    denials,
    host,
    state,
  };
}

describe("Sandbox lifecycle", () => {
  it("registers an enabled Bash owner after resolving one immutable policy", async () => {
    const watched = observer();
    const { controller: session, state } = controller({
      supportedMac: true,
      resolvePolicy: async () => policy,
      createDenialObserver: () => watched.value,
    });
    const ctx = context();
    const bash = await session.sessionStart({} as never, ctx as never);
    expect(bash.definition.name).toBe("bash");
    expect(state.enabled()).toBe(true);
    expect(state.policy()).toBe(policy);
    expect(watched.start).toHaveBeenCalledOnce();
    expect(ctx.statuses.get("pipkin:status:0100:sandbox")).toContain("sandbox");
    await session.sessionShutdown(ctx as never);
    expect(watched.dispose).toHaveBeenCalledOnce();
    expect(ctx.statuses.get("pipkin:status:0100:sandbox")).toBeUndefined();
  });

  it("keeps macOS Bash fail-closed when policy resolution fails", async () => {
    const watched = observer();
    const { controller: session, state } = controller({
      supportedMac: true,
      resolvePolicy: async () => {
        throw new Error("Git failed");
      },
      createDenialObserver: () => watched.value,
    });
    const ctx = context();
    const bash = await session.sessionStart({} as never, ctx as never);
    expect(bash.definition.name).toBe("bash");
    expect(state.policy()).toBeUndefined();
    expect(state.unavailableReason()).toContain("Git failed");
    expect(ctx.statuses.get("pipkin:status:0100:sandbox")).toContain(
      "unavailable",
    );
    expect(state.enabled()).toBe(true);
    await session.sessionShutdown(ctx as never);
  });

  it("applies inherited disabled mode after resolving the child policy", async () => {
    const child = createSandboxSessionState();
    child.setEnabled(true);
    const childPolicy = { ...policy, sessionCwd: "/workspace/child" };
    const { controller: session, state } = controller({
      state: child,
      supportedMac: true,
      resolvePolicy: async () => childPolicy,
      createDenialObserver: () => observer().value,
    });
    const ctx = { ...context(), cwd: "/workspace/child" };
    await session.sessionStart({} as never, ctx as never, false);

    expect(state.enabled()).toBe(false);
    expect(state.policy()).toBe(childPolicy);
    await session.sessionShutdown(ctx as never);
  });

  it("uses local Bash and unavailable status on Linux without policy resolution", async () => {
    const createDenialObserver = vi.fn(() => observer().value);
    const { controller: session, state } = controller({
      supportedMac: false,
      resolvePolicy: async () => {
        throw new Error("should not resolve");
      },
      createDenialObserver,
    });
    const ctx = context();
    const bash = await session.sessionStart({} as never, ctx as never);
    expect(bash.definition.name).toBe("bash");
    expect(state.policy()).toBeUndefined();
    expect(createDenialObserver).not.toHaveBeenCalled();
    expect(ctx.statuses.get("pipkin:status:0100:sandbox")).toContain(
      "unavailable",
    );
    await session.sessionShutdown(ctx as never);
  });

  it("binds only the current executor and revokes it before replacement and shutdown", async () => {
    const { controller: session, host } = controller({ supportedMac: false });
    const ctx = { ...context(), cwd: process.cwd() };
    const executionContext = {
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => "test-session",
      },
    } as never;
    const request = (command: string, timeout?: number) => ({
      toolCallId: "call",
      params: timeout === undefined ? { command } : { command, timeout },
      signal: undefined,
      onUpdate: undefined,
      ctx: executionContext,
    });

    const started = await session.sessionStart({} as never, ctx as never);
    const updates: unknown[] = [];
    const publicResult = await started.definition.execute(
      "public-call",
      { command: "printf first" },
      undefined,
      (update) => updates.push(update),
      executionContext,
    );
    const delegatedResult = await executeSandboxBash(
      host as never,
      request("printf first"),
    );
    expect(delegatedResult).toEqual(publicResult);
    expect(updates).not.toHaveLength(0);
    await expect(
      executeSandboxBash(host as never, request("printf never", 0)),
    ).rejects.toThrow("Invalid timeout");

    await session.sessionStart({} as never, ctx as never);
    await expect(
      executeSandboxBash(host as never, request("printf second")),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "second" }],
    });

    await session.sessionShutdown(ctx as never);
    await expect(
      executeSandboxBash(host as never, request("printf never")),
    ).rejects.toThrow("unavailable");
  });

  it("publishes a warning count after an active-runtime denial", async () => {
    const { controller: session, denials } = controller({
      supportedMac: true,
      resolvePolicy: async () => policy,
      createDenialObserver: () => observer().value,
    });
    const ctx = context();
    await session.sessionStart({} as never, ctx as never);
    denials.recordDirect({ tool: "write", reason: "blocked" });

    expect(ctx.statuses.get("pipkin:status:0100:sandbox")).toContain(
      "sandbox · 1 denied",
    );
    await session.sessionShutdown(ctx as never);
    denials.recordDirect({ tool: "write", reason: "later" });
    expect(ctx.statuses.get("pipkin:status:0100:sandbox")).toBeUndefined();
  });

  it("resets session diagnostics and replaces the observer on restart", async () => {
    const first = observer();
    const second = observer();
    const observers = [first, second];
    const {
      controller: session,
      denials,
      state: sessionState,
    } = controller({
      supportedMac: true,
      resolvePolicy: async () => policy,
      createDenialObserver: () => observers.shift()!.value,
    });
    const ctx = context();
    await session.sessionStart({} as never, ctx as never, false);
    expect(sessionState.enabled()).toBe(false);
    denials.recordDirect({ tool: "write", reason: "blocked" });
    await session.sessionShutdown(ctx as never);
    expect(denials.snapshot()).toEqual({ count: 0, recent: [] });
    await session.sessionStart({} as never, ctx as never);
    expect(sessionState.enabled()).toBe(true);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.start).toHaveBeenCalledOnce();
    await session.sessionShutdown(ctx as never);
  });
});
