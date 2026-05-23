import { describe, it, expect, beforeEach } from "vitest";

import { renderStatus, subscribeStatus, type StatusState } from "./status.js";
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
      for (const fn of subs) fn(current);
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
      for (const fn of listeners) fn();
    },
  };
}

function makeSubcommandContext(
  policyManager: PolicyManager,
): SubcommandContext {
  return {
    ui: { notify: () => {} },
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
    hasUI: false,
    allowedHostCount: 12,
    writableRootCount: 3,
  };

  it("normal state → N hosts · M writable", () => {
    const result = renderStatus({ ...baseState, hasUI: false });
    expect(result).toBe("🔒 sandbox · 12 hosts · 3 writable");
  });

  it("normal interactive state (non-interactive-only mode but not disabled) → network off (interactive)", () => {
    const result = renderStatus({ ...baseState, hasUI: true });
    expect(result).toBe("🔒 sandbox · network: off (interactive)");
  });

  it("network mode 'always' + hasUI=true → normal (N hosts)", () => {
    const result = renderStatus({
      ...baseState,
      networkMode: "always",
      hasUI: true,
    });
    expect(result).toBe("🔒 sandbox · 12 hosts · 3 writable");
  });

  it("network mode 'always' + hasUI=false → normal (N hosts)", () => {
    const result = renderStatus({
      ...baseState,
      networkMode: "always",
      hasUI: false,
    });
    expect(result).toBe("🔒 sandbox · 12 hosts · 3 writable");
  });

  it("network off (session) → network: ⚠ off", () => {
    const result = renderStatus({ ...baseState, networkOff: true });
    expect(result).toBe("🔒 sandbox · network: ⚠ off");
  });

  it("network off takes precedence over non-interactive-only + hasUI", () => {
    const result = renderStatus({
      ...baseState,
      networkOff: true,
      hasUI: true,
    });
    expect(result).toBe("🔒 sandbox · network: ⚠ off");
  });

  it("fully disabled (enabled=false) → ⚠ sandbox: off", () => {
    const result = renderStatus({ ...baseState, enabled: false });
    expect(result).toBe("⚠ sandbox: off");
  });

  it("in-process only degraded state", () => {
    const result = renderStatus({ ...baseState, inProcessOnly: true });
    expect(result).toBe("🔒 sandbox · in-process only");
  });

  it("disabled takes precedence over in-process only", () => {
    const result = renderStatus({
      ...baseState,
      enabled: false,
      inProcessOnly: true,
    });
    expect(result).toBe("⚠ sandbox: off");
  });

  it("network mode 'off' → network: off (config)", () => {
    const result = renderStatus({ ...baseState, networkMode: "off" });
    expect(result).toBe("🔒 sandbox · network: off (config)");
  });

  it("network mode 'off' + hasUI=true → network: off (config)", () => {
    const result = renderStatus({
      ...baseState,
      networkMode: "off",
      hasUI: true,
    });
    expect(result).toBe("🔒 sandbox · network: off (config)");
  });

  it("session networkOff takes precedence over mode 'off'", () => {
    const result = renderStatus({
      ...baseState,
      networkMode: "off",
      networkOff: true,
    });
    expect(result).toBe("🔒 sandbox · network: ⚠ off");
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
      hasUI: false,
      ui,
      onSessionMutation,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1].key).toBe("sandbox");
    dispose();
  });

  it("initial normal state with hasUI=false → N hosts · M writable", () => {
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
      hasUI: false,
      ui,
      onSessionMutation,
    });

    const text = calls[calls.length - 1].text;
    expect(text).toBe("🔒 sandbox · 3 hosts · 2 writable");
    dispose();
  });

  it("/sandbox network off → flips to network: ⚠ off", () => {
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
      hasUI: false,
      ui,
      onSessionMutation,
    });

    cmds.handleNetworkOff(ctx);
    triggerMutation();

    const text = calls[calls.length - 1].text;
    expect(text).toBe("🔒 sandbox · network: ⚠ off");
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
      hasUI: false,
      ui,
      onSessionMutation,
    });

    cmds.handleNetworkOff(ctx);
    triggerMutation();
    cmds.handleNetworkOn(ctx);
    triggerMutation();

    const text = calls[calls.length - 1].text;
    expect(text).toMatch(/hosts/);
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
      hasUI: false,
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
      hasUI: false,
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

  it("non-interactive-only + hasUI=true → network: off (interactive)", () => {
    const policy = makePolicy({
      network: { mode: "non-interactive-only", allow: [] },
    });
    const policyManager = makePolicyManager(policy);
    const { ui, calls } = makeStatusUI();
    const { onSessionMutation } = makeSessionMutationSubscriber();

    const dispose = subscribeStatus({
      policyManager,
      getSessionState: () => cmds.getSessionState(),
      hasUI: true,
      ui,
      onSessionMutation,
    });

    const text = calls[calls.length - 1].text;
    expect(text).toBe("🔒 sandbox · network: off (interactive)");
    dispose();
  });

  it("policy reload updates host count", () => {
    type Subscriber = (p: Policy) => void;
    const policySubscribers: Set<Subscriber> = new Set();
    let currentPolicy = makePolicy({
      network: { mode: "always", allow: ["a.com"] },
    });

    const policyManager: PolicyManager = {
      getPolicy: () => currentPolicy,
      loadPolicy: () => currentPolicy,
      reloadPolicy: () => {
        for (const fn of policySubscribers) fn(currentPolicy);
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
      hasUI: false,
      ui,
      onSessionMutation,
    });

    currentPolicy = makePolicy({
      network: { mode: "always", allow: ["a.com", "b.com", "c.com"] },
    });
    policyManager.reloadPolicy("/tmp");

    const text = calls[calls.length - 1].text;
    expect(text).toMatch(/3 hosts/);
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
      hasUI: false,
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
      hasUI: false,
      ui,
      onSessionMutation,
      inProcessOnly: true,
    });

    const text = calls[calls.length - 1].text;
    expect(text).toBe("🔒 sandbox · in-process only");
    dispose();
  });
});
