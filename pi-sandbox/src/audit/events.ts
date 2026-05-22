import type { AuditEntry, SandboxAuditEvent, SandboxPolicyChangedEvent } from "./schema.js";

const BLOCKED_HOSTS_RING_SIZE = 20;

export interface EventsTarget {
  emit: (event: string, payload: unknown) => void;
}

export interface AuditEmitter {
  getRecentBlockedHosts: () => readonly string[];
  emitAuditEvents: (entry: AuditEntry, events: EventsTarget) => void;
}

export function createAuditEmitter(): AuditEmitter {
  const recentBlockedHosts: string[] = [];

  function trackBlockedHost(entry: AuditEntry): void {
    if (entry.decision !== "blocked" || entry.host == null) return;
    const host = entry.host;
    const existing = recentBlockedHosts.indexOf(host);
    if (existing !== -1) {
      recentBlockedHosts.splice(existing, 1);
    }
    recentBlockedHosts.push(host);
    if (recentBlockedHosts.length > BLOCKED_HOSTS_RING_SIZE) {
      recentBlockedHosts.shift();
    }
  }

  function emitAuditEvents(entry: AuditEntry, events: EventsTarget): void {
    trackBlockedHost(entry);

    const auditEvent: SandboxAuditEvent = { ...entry };
    events.emit("sandbox:audit", auditEvent);

    if (entry.kind === "policy-change") {
      const policyChangedEvent: SandboxPolicyChangedEvent = {
        ts: entry.ts,
        source: entry.source,
        scope: entry.scope,
      };
      events.emit("sandbox:policy-changed", policyChangedEvent);
    }
  }

  return {
    getRecentBlockedHosts: () => recentBlockedHosts,
    emitAuditEvents,
  };
}

