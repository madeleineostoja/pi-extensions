export type AuditEntry = {
  ts: number;
  kind: "fs" | "network" | "exec" | "policy-change";
  decision: "allowed" | "blocked" | "granted" | "revoked";
  rule?: string;
  tool?: string;
  toolCallId?: string;
  path?: string;
  host?: string;
  scope?: "once" | "session" | "parent-session" | "persisted" | "block";
  source?: "config" | "command" | "prompt" | `ext:${string}`;
};

export type SandboxAuditEvent = AuditEntry & {};

export type SandboxPolicyChangedEvent = {
  ts: number;
  source?: "config" | "command" | "prompt" | `ext:${string}`;
  scope?: "session" | "parent-session" | "persisted";
};
