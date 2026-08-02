import { describe, expect, it, vi } from "vitest";
import type { SandboxDenialObserver } from "./denial-observer.js";
import { createSandboxDenialRecorder } from "./denials.js";
import { createSandboxSessionController } from "./lifecycle.js";
import type { SandboxPolicy } from "./policy.js";
import { createSandboxSessionState } from "./state.js";

const policy = {
  sessionCwd: "/workspace",
  workspaceRoot: "/workspace",
  temporaryRoots: [],
  cacheRoots: [],
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
  return {
    controller: createSandboxSessionController({
      state,
      denials,
      supportedMac: options.supportedMac,
      resolvePolicy: options.resolvePolicy,
      createDenialObserver: options.createDenialObserver
        ? () => options.createDenialObserver!()
        : undefined,
    }),
    denials,
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
    expect(bash.name).toBe("bash");
    expect(state.enabled()).toBe(true);
    expect(state.policy()).toBe(policy);
    expect(watched.start).toHaveBeenCalledOnce();
    expect(ctx.statuses.get("pipkin.sandbox")).toContain("sandbox");
    await session.sessionShutdown(ctx as never);
    expect(watched.dispose).toHaveBeenCalledOnce();
    expect(ctx.statuses.get("pipkin.sandbox")).toBeUndefined();
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
    expect(bash.name).toBe("bash");
    expect(state.policy()).toBeUndefined();
    expect(state.unavailableReason()).toContain("Git failed");
    expect(ctx.statuses.get("pipkin.sandbox")).toContain("unavailable");
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
    expect(bash.name).toBe("bash");
    expect(state.policy()).toBeUndefined();
    expect(createDenialObserver).not.toHaveBeenCalled();
    expect(ctx.statuses.get("pipkin.sandbox")).toContain("unavailable");
    await session.sessionShutdown(ctx as never);
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
