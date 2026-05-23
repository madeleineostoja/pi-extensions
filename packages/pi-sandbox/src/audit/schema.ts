export type AuditEntry = {
  ts: number;
  kind: "fs" | "network" | "exec" | "policy-change";
  decision: "allowed" | "blocked" | "granted" | "revoked";
  rule?: string;
  tool?: string;
  toolCallId?: string;
  path?: string;
  host?: string;
  scope?: "session" | "persisted";
  source?: "config" | "command" | `ext:${string}`;
};

export type SandboxAuditEvent = AuditEntry & {};

export interface SandboxPolicyChangedEvent {
  ts: number;
  source?: "config" | "command" | `ext:${string}`;
  scope?: "session" | "persisted";
}
