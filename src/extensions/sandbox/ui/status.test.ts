import { describe, it, expect, beforeEach } from "vitest";

import {
  renderStatus,
  renderStatusThemed,
  subscribeStatus,
  type StatusState,
} from "./status.js";
import {
  createSlashCommands,
  type SubcommandContext,
} from "../slash/commands.js";
import { createAuditPipeline } from "../audit/audit.js";
import type { PolicyManager } from "../policy/load.js";
import type { Policy } from "../policy/defaults.js";
import type { StatusUI } from "./status.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    enabled: true,
    fs: {
      allowRead: ["/tmp"],
      allowWrite: ["/tmp", "/home/user"],
      denyPatterns: [],
    },
    network: {
      mode: "non-interactive-only",
      allow: ["github.com", "npmjs.org", "pypi.org"],
    },
    audit: { log: false, logFile: "/tmp/audit.jsonl" },
    enforcement: { requireKernelSandbox: false },
    ...overrides,
  };
}

function makePolicyManager(policy: Policy): PolicyManager {
  type Subscriber = (p: Policy) => void;
  const subs: Set<Subscriber> = new Set();
  let current = policy;
  return {
    getPolicy: () => current,
    loadPolicy: () => current,
    reloadPolicy: () => {
      for (const fn of subs) {
        fn(current);
      }
      return current;
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

function makeStatusUI(): {
  ui: StatusUI;
  calls: Array<{ key: string; text: string | undefined }>;
} {
  const calls: Array<{ key: string; text: string | undefined }> = [];
  const ui: StatusUI = {
    setStatus: (key, text) => calls.push({ key, text }),
  };
  return { ui, calls };
}

function makeSessionMutationSubscriber(): {
  onSessionMutation: (fn: () => void) => () => void;
  triggerMutation: () => void;
} {
  const listeners: Set<() => void> = new Set();
  return {
    onSessionMutation: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    triggerMutation: () => {
      for (const fn of listeners) {
        fn();
      }
    },
  };
}

function makeSubcommandContext(
  policyManager: PolicyManager,
): SubcommandContext {
  return {
    ui: {
      notify: () => {},
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => false,
    },
    policyManager,
    cwd: "/tmp",
    events: undefined,
  };
}

// ---------------------------------------------------------------------------
// Unit tests: renderStatus pure function
// ---------------------------------------------------------------------------

describe("renderStatus — pure renderer", () => {
  const baseState: StatusState = {
    enabled: true,
    networkOff: false,
    networkMode: "non-interactive-only",
    mode: "rpc",
  };

  it("non-interactive-only + mode=rpc → sandbox (network)", () => {
    expect(renderStatus({ ...baseState, mode: "rpc" })).toBe(
      "🔒 sandbox (network)",
    );
  });

  it("non-interactive-only + mode=tui → sandbox (file only)", () => {
    expect(renderStatus({ ...baseState, mode: "tui" })).toBe("🔒 sandbox");
  });

  it("network mode 'always' → sandbox (network) regardless of mode", () => {
    expect(
      renderStatus({ ...baseState, networkMode: "always", mode: "tui" }),
    ).toBe("🔒 sandbox (network)");
    expect(
      renderStatus({ ...baseState, networkMode: "always", mode: "rpc" }),
    ).toBe("🔒 sandbox (network)");
  });

  it("session networkOff → sandbox (network) (blocks all)", () => {
    expect(renderStatus({ ...baseState, networkOff: true })).toBe(
      "🔒 sandbox (network)",
    );
  });

  it("fully disabled → ⚠ sandbox: off", () => {
    expect(renderStatus({ ...baseState, enabled: false })).toBe(
      "⚠ sandbox: off",
    );
  });

  it("in-process only → sandbox (degraded)", () => {
    expect(renderStatus({ ...baseState, inProcessOnly: true })).toBe(
      "🔒 sandbox (degraded)",
    );
  });

  it("disabled takes precedence over in-process only", () => {
    expect(
      renderStatus({ ...baseState, enabled: false, inProcessOnly: true }),
    ).toBe("⚠ sandbox: off");
  });

  it("network mode 'off' → sandbox (network)", () => {
    expect(renderStatus({ ...baseState, networkMode: "off" })).toBe(
      "🔒 sandbox (network)",
    );
  });
});

// ---------------------------------------------------------------------------
// Integration tests: subscribeStatus glue layer
// ---------------------------------------------------------------------------

describe("subscribeStatus — integration", () => {
  let cmds: ReturnType<typeof createSlashCommands>;

  beforeEach(() => {
    cmds = createSlashCommands(createAuditPipeline());
  });

  it("calls setStatus immediately on subscribe", () => {
    const policy = makePolicy({
      network: { mode: "always", allow: ["a.com", "b.com"] },
    });
    const policyManager = makePolicyManager(policy);
    const { ui, calls } = makeStatusUI();
    const { onSessionMutation } = makeSessionMutationSubscriber();

    const dispose = subscribeStatus({
      policyManager,
      getSessionState: () => cmds.getSessionState(),
      mode: "rpc",
      ui,
      onSessionMutation,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1].key).toBe("sandbox");
    dispose();
  });

  it("initial state mode=always mode=rpc → sandbox (network)", () => {
    const policy = makePolicy({
      network: { mode: "always", allow: ["a.com", "b.com", "c.com"] },
      fs: {
        allowRead: ["/tmp"],
        allowWrite: ["/tmp", "/var"],
        denyPatterns: [],
      },
    });
    const policyManager = makePolicyManager(policy);
    const { ui, calls } = makeStatusUI();
    const { onSessionMutation } = makeSessionMutationSubscriber();

    const dispose = subscribeStatus({
      policyManager,
      getSessionState: () => cmds.getSessionState(),
      mode: "rpc",
      ui,
      onSessionMutation,
    });

    const text = calls[calls.length - 1].text;
    expect(text).toBe("🔒 sandbox (network)");
    dispose();
  });

  it("/sandbox network off → sandbox (network)", () => {
    const policy = makePolicy({
      network: { mode: "always", allow: ["a.com"] },
    });
    const policyManager = makePolicyManager(policy);
    const ctx = makeSubcommandContext(policyManager);
    const { ui, calls } = makeStatusUI();
    const { onSessionMutation, triggerMutation } =
      makeSessionMutationSubscriber();

    const dispose = subscribeStatus({
      policyManager,
      getSessionState: () => cmds.getSessionState(),
      mode: "rpc",
      ui,
      onSessionMutation,
    });

    cmds.handleNetworkOff(ctx);
    triggerMutation();

    const text = calls[calls.length - 1].text;
    expect(text).toBe("🔒 sandbox (network)");
    dispose();
  });

  it("/sandbox network on after off → returns to normal", () => {
    const policy = makePolicy({
      network: { mode: "always", allow: ["a.com"] },
    });
    const policyManager = makePolicyManager(policy);
    const ctx = makeSubcommandContext(policyManager);
    const { ui, calls } = makeStatusUI();
    const { onSessionMutation, triggerMutation } =
      makeSessionMutationSubscriber();

    const dispose = subscribeStatus({
      policyManager,
      getSessionState: () => cmds.getSessionState(),
      mode: "rpc",
      ui,
      onSessionMutation,
    });

    cmds.handleNetworkOff(ctx);
    triggerMutation();
    cmds.handleNetworkOn(ctx);
    triggerMutation();

    const text = calls[calls.length - 1].text;
    expect(text).toBe("🔒 sandbox (network)");
    dispose();
  });

  it("/sandbox off → flips to ⚠ sandbox: off", () => {
    const policy = makePolicy({
      network: { mode: "always", allow: ["a.com"] },
    });
    const policyManager = makePolicyManager(policy);
    const ctx = makeSubcommandContext(policyManager);
    const { ui, calls } = makeStatusUI();
    const { onSessionMutation, triggerMutation } =
      makeSessionMutationSubscriber();

    const dispose = subscribeStatus({
      policyManager,
      getSessionState: () => cmds.getSessionState(),
      mode: "rpc",
      ui,
      onSessionMutation,
    });

    cmds.handleOff(ctx);
    triggerMutation();

    const text = calls[calls.length - 1].text;
    expect(text).toBe("⚠ sandbox: off");
    dispose();
  });

  it("/sandbox on after off → returns to non-disabled state", () => {
    const policy = makePolicy({
      network: { mode: "always", allow: ["a.com"] },
    });
    const policyManager = makePolicyManager(policy);
    const ctx = makeSubcommandContext(policyManager);
    const { ui, calls } = makeStatusUI();
    const { onSessionMutation, triggerMutation } =
      makeSessionMutationSubscriber();

    const dispose = subscribeStatus({
      policyManager,
      getSessionState: () => cmds.getSessionState(),
      mode: "rpc",
      ui,
      onSessionMutation,
    });

    cmds.handleOff(ctx);
    triggerMutation();
    cmds.handleOn(ctx);
    triggerMutation();

    const text = calls[calls.length - 1].text;
    expect(text).not.toContain("off");
    dispose();
  });

  it("non-interactive-only + mode=tui → bare sandbox (network unrestricted)", () => {
    const policy = makePolicy({
      network: { mode: "non-interactive-only", allow: [] },
    });
    const policyManager = makePolicyManager(policy);
    const { ui, calls } = makeStatusUI();
    const { onSessionMutation } = makeSessionMutationSubscriber();

    const dispose = subscribeStatus({
      policyManager,
      getSessionState: () => cmds.getSessionState(),
      mode: "tui",
      ui,
      onSessionMutation,
    });

    const text = calls[calls.length - 1].text;
    expect(text).toBe("🔒 sandbox");
    dispose();
  });

  it("policy reload re-renders status", () => {
    type Subscriber = (p: Policy) => void;
    const policySubscribers: Set<Subscriber> = new Set();
    let currentPolicy = makePolicy({
      network: { mode: "always", allow: ["a.com"] },
    });

    const policyManager: PolicyManager = {
      getPolicy: () => currentPolicy,
      loadPolicy: () => currentPolicy,
      reloadPolicy: () => {
        for (const fn of policySubscribers) {
          fn(currentPolicy);
        }
        return currentPolicy;
      },
      subscribe: (fn) => {
        policySubscribers.add(fn);
        return () => policySubscribers.delete(fn);
      },
    };

    const { ui, calls } = makeStatusUI();
    const { onSessionMutation } = makeSessionMutationSubscriber();

    const dispose = subscribeStatus({
      policyManager,
      getSessionState: () => cmds.getSessionState(),
      mode: "rpc",
      ui,
      onSessionMutation,
    });

    const countBefore = calls.length;
    currentPolicy = makePolicy({
      network: { mode: "off", allow: [] },
    });
    policyManager.reloadPolicy("/tmp");

    expect(calls.length).toBeGreaterThan(countBefore);
    const text = calls[calls.length - 1].text;
    expect(text).toBe("🔒 sandbox (network)");
    dispose();
  });

  it("dispose clears the status and unsubscribes", () => {
    const policy = makePolicy({ network: { mode: "always", allow: [] } });
    const policyManager = makePolicyManager(policy);
    const { ui, calls } = makeStatusUI();
    const { onSessionMutation, triggerMutation } =
      makeSessionMutationSubscriber();

    const dispose = subscribeStatus({
      policyManager,
      getSessionState: () => cmds.getSessionState(),
      mode: "rpc",
      ui,
      onSessionMutation,
    });

    dispose();

    const lastCall = calls[calls.length - 1];
    expect(lastCall.key).toBe("sandbox");
    expect(lastCall.text).toBeUndefined();

    const countBefore = calls.length;
    triggerMutation();
    expect(calls.length).toBe(countBefore);
  });

  it("in-process only degraded state", () => {
    const policy = makePolicy({ network: { mode: "always", allow: [] } });
    const policyManager = makePolicyManager(policy);
    const { ui, calls } = makeStatusUI();
    const { onSessionMutation } = makeSessionMutationSubscriber();

    const dispose = subscribeStatus({
      policyManager,
      getSessionState: () => cmds.getSessionState(),
      mode: "rpc",
      ui,
      onSessionMutation,
      inProcessOnly: true,
    });

    const text = calls[calls.length - 1].text;
    expect(text).toBe("🔒 sandbox (degraded)");
    dispose();
  });
});

// ---------------------------------------------------------------------------
// Themed rendering tests
// ---------------------------------------------------------------------------

function makeThemeSpy() {
  const calls: Array<{ color: string; text: string }> = [];
  return {
    theme: {
      fg: (color: string, text: string) => {
        calls.push({ color, text });
        return `<${color}>${text}</${color}>`;
      },
    },
    calls,
  };
}

describe("renderStatusThemed", () => {
  const baseState: StatusState = {
    enabled: true,
    networkOff: false,
    networkMode: "non-interactive-only",
    mode: "rpc",
  };

  it("bare sandbox (network unrestricted) → success icon and muted text", () => {
    const { theme, calls } = makeThemeSpy();
    const result = renderStatusThemed({ ...baseState, mode: "tui" }, theme);
    expect(result).toContain("󰒃");
    expect(result).toContain("sandbox");
    expect(calls).toContainEqual({ color: "success", text: "󰒃" });
    expect(calls).toContainEqual({ color: "muted", text: "sandbox" });
    expect(result).not.toContain("(network)");
    expect(result).not.toContain("\n");
  });

  it("network sandboxed → success icon and muted (network) text", () => {
    const { theme, calls } = makeThemeSpy();
    const result = renderStatusThemed({ ...baseState, mode: "rpc" }, theme);
    expect(result).toContain("sandbox (network)");
    expect(calls).toContainEqual({ color: "success", text: "󰒃" });
    expect(calls).toContainEqual({
      color: "muted",
      text: "sandbox (network)",
    });
    expect(result).not.toContain("\n");
  });

  it("disabled → warning icon and warning text", () => {
    const { theme, calls } = makeThemeSpy();
    const result = renderStatusThemed({ ...baseState, enabled: false }, theme);
    expect(result).toContain("sandbox: off");
    expect(calls).toContainEqual({ color: "warning", text: "󰒃" });
    expect(calls).toContainEqual({ color: "warning", text: "sandbox: off" });
    expect(result).not.toContain("\n");
  });

  it("in-process only → warning icon and warning text", () => {
    const { theme, calls } = makeThemeSpy();
    const result = renderStatusThemed(
      { ...baseState, inProcessOnly: true },
      theme,
    );
    expect(result).toContain("sandbox (degraded)");
    expect(calls).toContainEqual({ color: "warning", text: "󰒃" });
    expect(calls).toContainEqual({
      color: "warning",
      text: "sandbox (degraded)",
    });
    expect(result).not.toContain("sandbox: off");
    expect(result).not.toContain("\n");
  });

  it("network off (session) → success icon, muted (network) text", () => {
    const { theme, calls } = makeThemeSpy();
    const result = renderStatusThemed(
      { ...baseState, networkOff: true },
      theme,
    );
    expect(result).toContain("sandbox (network)");
    expect(calls).toContainEqual({ color: "success", text: "󰒃" });
    expect(calls).toContainEqual({
      color: "muted",
      text: "sandbox (network)",
    });
    expect(result).not.toContain("\n");
  });

  it("network mode 'off' → success icon, muted (network) text", () => {
    const { theme, calls } = makeThemeSpy();
    const result = renderStatusThemed(
      { ...baseState, networkMode: "off" },
      theme,
    );
    expect(result).toContain("sandbox (network)");
    expect(calls).toContainEqual({ color: "success", text: "󰒃" });
    expect(calls).toContainEqual({
      color: "muted",
      text: "sandbox (network)",
    });
    expect(result).not.toContain("\n");
  });

  it("non-interactive-only + mode=tui → bare sandbox, no (network)", () => {
    const { theme, calls } = makeThemeSpy();
    const result = renderStatusThemed(
      { ...baseState, networkMode: "non-interactive-only", mode: "tui" },
      theme,
    );
    expect(result).not.toContain("(network)");
    expect(result).toContain("sandbox");
    expect(calls).toContainEqual({ color: "success", text: "󰒃" });
    expect(calls).toContainEqual({ color: "muted", text: "sandbox" });
    expect(result).not.toContain("\n");
  });

  it("subscribeStatus with theme uses themed rendering", () => {
    const localCmds = createSlashCommands(createAuditPipeline());
    const policy = makePolicy({ network: { mode: "always", allow: [] } });
    const policyManager = makePolicyManager(policy);
    const { ui, calls } = makeStatusUI();
    const { onSessionMutation } = makeSessionMutationSubscriber();
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    };

    const dispose = subscribeStatus({
      policyManager,
      getSessionState: () => localCmds.getSessionState(),
      mode: "rpc",
      ui,
      onSessionMutation,
      theme,
    });

    const text = calls[calls.length - 1].text;
    expect(text).toContain("󰒃");
    expect(text).toContain("sandbox");
    expect(text).toContain("<success>");
    expect(text).not.toContain("\n");
    dispose();
  });
});
