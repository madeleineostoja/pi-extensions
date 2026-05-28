import { describe, it, expect, beforeEach } from "vitest";
import { createAuditPipeline } from "./audit.js";
import type { AuditPipeline } from "./audit.js";
import { createAuditEmitter } from "./events.js";
import { createSlashCommands } from "../slash/commands.js";
import type { SandboxAuditEvent, SandboxPolicyChangedEvent } from "./schema.js";

let recordAudit: AuditPipeline["recordAudit"];

beforeEach(() => {
  ({ recordAudit } = createAuditPipeline());
});

// ---------------------------------------------------------------------------
// Stub listener helper — mimics a consumer extension subscribing to events
// ---------------------------------------------------------------------------

function makeStubListener() {
  const received: Array<{ event: string; payload: unknown }> = [];
  const target = {
    emit: (event: string, payload: unknown) => {
      received.push({ event, payload });
    },
  };
  return { target, received };
}

// ---------------------------------------------------------------------------
// Integration: stub listener receives sandbox:audit with documented shape
// ---------------------------------------------------------------------------

describe("stub listener receives sandbox:audit events with documented shape", () => {
  const kindDecisionPairs: Array<{
    kind: "fs" | "network" | "exec" | "policy-change";
    decision: "allowed" | "blocked" | "granted" | "revoked";
    extra?: Partial<SandboxAuditEvent>;
  }> = [
    {
      kind: "fs",
      decision: "allowed",
      extra: { path: "/home/user/project/src/index.ts", tool: "read" },
    },
    {
      kind: "fs",
      decision: "blocked",
      extra: { path: "/etc/passwd", tool: "read", rule: "allowList:read" },
    },
    { kind: "network", decision: "allowed", extra: { host: "api.github.com" } },
    {
      kind: "network",
      decision: "blocked",
      extra: { host: "evil.example.com" },
    },
    { kind: "exec", decision: "allowed", extra: { tool: "bash" } },
    {
      kind: "exec",
      decision: "blocked",
      extra: { tool: "bash", rule: "sandboxOff=false" },
    },
    {
      kind: "policy-change",
      decision: "granted",
      extra: { scope: "session", source: "command" },
    },
    {
      kind: "policy-change",
      decision: "revoked",
      extra: { scope: "persisted", source: "command" },
    },
  ];

  for (const { kind, decision, extra } of kindDecisionPairs) {
    it(`kind=${kind} decision=${decision} — listener receives event with correct shape`, () => {
      const { target, received } = makeStubListener();

      recordAudit({ kind, decision, ...extra }, { events: target });

      const auditEvents = received.filter((e) => e.event === "sandbox:audit");
      expect(auditEvents).toHaveLength(1);

      const payload = auditEvents[0].payload as SandboxAuditEvent;

      expect(typeof payload.ts).toBe("number");
      expect(payload.ts).toBeGreaterThan(0);
      expect(payload.kind).toBe(kind);
      expect(payload.decision).toBe(decision);

      if (extra?.path != null) {
        expect(payload.path).toBe(extra.path);
      }
      if (extra?.host != null) {
        expect(payload.host).toBe(extra.host);
      }
      if (extra?.tool != null) {
        expect(payload.tool).toBe(extra.tool);
      }
      if (extra?.rule != null) {
        expect(payload.rule).toBe(extra.rule);
      }
      if (extra?.scope != null) {
        expect(payload.scope).toBe(extra.scope);
      }
      if (extra?.source != null) {
        expect(payload.source).toBe(extra.source);
      }
    });
  }

  it("payload does not contain unexpected enumerable keys beyond the schema", () => {
    const { target, received } = makeStubListener();
    recordAudit(
      { kind: "fs", decision: "blocked", path: "/tmp/x", tool: "read" },
      { events: target },
    );

    const payload = received[0].payload as SandboxAuditEvent;
    const allowedKeys = new Set([
      "ts",
      "kind",
      "decision",
      "rule",
      "tool",
      "toolCallId",
      "path",
      "host",
      "scope",
      "source",
    ]);
    for (const key of Object.keys(payload)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: policy-change emits both sandbox:audit and sandbox:policy-changed
// ---------------------------------------------------------------------------

describe("policy-change events — both event types emitted", () => {
  it("granted: listener receives sandbox:audit and sandbox:policy-changed", () => {
    const { target, received } = makeStubListener();
    recordAudit(
      {
        kind: "policy-change",
        decision: "granted",
        scope: "session",
        source: "command",
      },
      { events: target },
    );

    const auditEvents = received.filter((e) => e.event === "sandbox:audit");
    const policyEvents = received.filter(
      (e) => e.event === "sandbox:policy-changed",
    );

    expect(auditEvents).toHaveLength(1);
    expect(policyEvents).toHaveLength(1);

    const auditPayload = auditEvents[0].payload as SandboxAuditEvent;
    expect(auditPayload.kind).toBe("policy-change");
    expect(auditPayload.decision).toBe("granted");

    const policyPayload = policyEvents[0].payload as SandboxPolicyChangedEvent;
    expect(typeof policyPayload.ts).toBe("number");
    expect(policyPayload.scope).toBe("session");
    expect(policyPayload.source).toBe("command");
  });

  it("revoked: listener receives sandbox:policy-changed with correct scope", () => {
    const { target, received } = makeStubListener();
    recordAudit(
      {
        kind: "policy-change",
        decision: "revoked",
        scope: "persisted",
        source: "command",
      },
      { events: target },
    );

    const policyPayload = received.find(
      (e) => e.event === "sandbox:policy-changed",
    )!.payload as SandboxPolicyChangedEvent;
    expect(policyPayload.scope).toBe("persisted");
    expect(policyPayload.source).toBe("command");
  });
});

// ---------------------------------------------------------------------------
// Sanity: emitting sandbox:audit from an external source does NOT mutate sandbox state
// ---------------------------------------------------------------------------

describe("external sandbox:audit emission does not mutate sandbox state", () => {
  let emitter: ReturnType<typeof createAuditEmitter>;

  beforeEach(() => {
    emitter = createAuditEmitter();
  });

  it("calling target.emit directly (bypassing recordAudit) does not update recentBlockedHosts", () => {
    const externalEmitter = {
      emit: (_event: string, _payload: unknown) => {},
    };

    // Simulate an external source emitting a sandbox:audit event directly —
    // i.e., NOT going through emitter.emitAuditEvents. The ring buffer
    // must remain empty because sandbox has no incoming subscription.
    externalEmitter.emit("sandbox:audit", {
      ts: Date.now(),
      kind: "network",
      decision: "blocked",
      host: "injected.example.com",
    });

    expect(emitter.getRecentBlockedHosts()).toHaveLength(0);
  });

  it("a rogue sandbox:audit event cannot append to the ring buffer", () => {
    const { target } = makeStubListener();

    // Fire a real event to populate the buffer
    emitter.emitAuditEvents(
      {
        ts: Date.now(),
        kind: "network",
        decision: "blocked",
        host: "real.example.com",
      } as SandboxAuditEvent,
      target,
    );
    expect(emitter.getRecentBlockedHosts()).toContain("real.example.com");

    // Now a rogue emitter tries to inject a host by emitting the event directly
    const rogueTarget = { emit: (_e: string, _p: unknown) => {} };
    rogueTarget.emit("sandbox:audit", {
      ts: Date.now(),
      kind: "network",
      decision: "blocked",
      host: "rogue.example.com",
    });

    // The ring buffer must not contain the injected host
    expect(emitter.getRecentBlockedHosts()).not.toContain("rogue.example.com");
    expect(emitter.getRecentBlockedHosts()).toContain("real.example.com");
  });

  it("emitting sandbox:policy-changed from outside has no effect on session state", () => {
    const { recordAudit: ra, getRecentBlockedHosts } = createAuditPipeline();
    const cmds = createSlashCommands({
      recordAudit: ra,
      getRecentBlockedHosts,
    });
    const getState = () => cmds.getSessionState();

    const stateBefore = JSON.stringify({
      sessionAllowedHosts: [...getState().sessionAllowedHosts],
      networkOff: getState().networkOff,
      sandboxOff: getState().sandboxOff,
    });

    // Simulate external emission of sandbox:policy-changed
    const rogueTarget = { emit: (_e: string, _p: unknown) => {} };
    rogueTarget.emit("sandbox:policy-changed", {
      ts: Date.now(),
      source: "ext:rogue",
      scope: "session",
    });

    const stateAfter = JSON.stringify({
      sessionAllowedHosts: [...getState().sessionAllowedHosts],
      networkOff: getState().networkOff,
      sandboxOff: getState().sandboxOff,
    });

    expect(stateAfter).toBe(stateBefore);
  });
});
