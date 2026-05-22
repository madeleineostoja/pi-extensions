import { describe, it, expect } from "vitest";
import { applySessionOverrides } from "../effective.js";
import type { Policy } from "../defaults.js";
import type { SessionState } from "../../slash/commands.js";

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    enabled: true,
    fs: {
      allowRead: ["/home/user"],
      allowWrite: ["/home/user/project"],
      denyPatterns: ["**/.env"],
    },
    network: {
      mode: "non-interactive-only",
      allow: ["github.com", "api.github.com"],
    },
    audit: { log: false, logFile: "/tmp/audit.jsonl" },
    enforcement: { requireKernelSandbox: false },
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionAllowedHosts: new Set(),
    networkOff: false,
    sandboxOff: false,
    ...overrides,
  };
}

describe("applySessionOverrides — no-op", () => {
  it("returns a policy equal to the input when session is default", () => {
    const policy = makePolicy();
    const session = makeSession();
    const result = applySessionOverrides(policy, session);
    expect(result.enabled).toBe(true);
    expect(result.network.mode).toBe("non-interactive-only");
    expect(result.network.allow).toEqual(["github.com", "api.github.com"]);
  });
});

describe("applySessionOverrides — sandboxOff", () => {
  it("sets enabled to false when sandboxOff is true", () => {
    const policy = makePolicy();
    const session = makeSession({ sandboxOff: true });
    const result = applySessionOverrides(policy, session);
    expect(result.enabled).toBe(false);
  });

  it("preserves all other fields when sandboxOff is true", () => {
    const policy = makePolicy();
    const session = makeSession({ sandboxOff: true });
    const result = applySessionOverrides(policy, session);
    expect(result.network).toEqual(policy.network);
    expect(result.fs).toEqual(policy.fs);
    expect(result.audit).toEqual(policy.audit);
  });
});

describe("applySessionOverrides — networkOff", () => {
  it("sets network.mode to 'off' when networkOff is true", () => {
    const policy = makePolicy();
    const session = makeSession({ networkOff: true });
    const result = applySessionOverrides(policy, session);
    expect(result.network.mode).toBe("off");
  });

  it("restores network.mode to configured value when networkOff is false", () => {
    const policy = makePolicy({ network: { mode: "always", allow: [] } });
    const session = makeSession({ networkOff: false });
    const result = applySessionOverrides(policy, session);
    expect(result.network.mode).toBe("always");
  });

  it("preserves network.allow when networkOff is true", () => {
    const policy = makePolicy();
    const session = makeSession({ networkOff: true });
    const result = applySessionOverrides(policy, session);
    expect(result.network.allow).toEqual(["github.com", "api.github.com"]);
  });
});

describe("applySessionOverrides — sessionAllowedHosts", () => {
  it("merges session hosts into network.allow additively", () => {
    const policy = makePolicy();
    const session = makeSession({ sessionAllowedHosts: new Set(["example.com"]) });
    const result = applySessionOverrides(policy, session);
    expect(result.network.allow).toContain("example.com");
    expect(result.network.allow).toContain("github.com");
    expect(result.network.allow).toContain("api.github.com");
  });

  it("deduplicates hosts that appear in both configured and session allow lists", () => {
    const policy = makePolicy();
    const session = makeSession({ sessionAllowedHosts: new Set(["github.com"]) });
    const result = applySessionOverrides(policy, session);
    const githubCount = result.network.allow.filter((h) => h === "github.com").length;
    expect(githubCount).toBe(1);
  });

  it("does not mutate the original policy network.allow array", () => {
    const policy = makePolicy();
    const originalAllow = [...policy.network.allow];
    const session = makeSession({ sessionAllowedHosts: new Set(["example.com"]) });
    applySessionOverrides(policy, session);
    expect(policy.network.allow).toEqual(originalAllow);
  });
});

describe("applySessionOverrides — purity", () => {
  it("does not mutate the input policy object", () => {
    const policy = makePolicy();
    const session = makeSession({ sandboxOff: true, networkOff: true });
    const beforeEnabled = policy.enabled;
    const beforeMode = policy.network.mode;
    applySessionOverrides(policy, session);
    expect(policy.enabled).toBe(beforeEnabled);
    expect(policy.network.mode).toBe(beforeMode);
  });

  it("does not mutate the input session object", () => {
    const policy = makePolicy();
    const session = makeSession({ sessionAllowedHosts: new Set(["example.com"]) });
    const beforeSize = session.sessionAllowedHosts.size;
    applySessionOverrides(policy, session);
    expect(session.sessionAllowedHosts.size).toBe(beforeSize);
  });

  it("returns a new object (not the same reference)", () => {
    const policy = makePolicy();
    const session = makeSession();
    const result = applySessionOverrides(policy, session);
    expect(result).not.toBe(policy);
  });

  it("same inputs always produce equal outputs", () => {
    const policy = makePolicy();
    const session = makeSession({ sessionAllowedHosts: new Set(["example.com"]) });
    const r1 = applySessionOverrides(policy, session);
    const r2 = applySessionOverrides(policy, session);
    expect(r1.enabled).toBe(r2.enabled);
    expect(r1.network.mode).toBe(r2.network.mode);
    expect(r1.network.allow).toEqual(r2.network.allow);
  });
});
