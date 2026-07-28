export type ReadonlyAction =
  | { kind: "toggle" }
  | { kind: "set"; value: boolean }
  | { kind: "invalid" };

export function extractToolPath(input: unknown): string | undefined {
  const path =
    input && typeof input === "object"
      ? (input as { path?: unknown }).path
      : undefined;
  return typeof path === "string" && path ? path : undefined;
}

export function formatSteerTitle(path: string | undefined): string {
  return path ? `Steer the agent — ${path}` : "Steer the agent";
}

export function parseReadonlyArgs(args: string): ReadonlyAction {
  const value = args.trim().toLowerCase();
  if (!value) {
    return { kind: "toggle" };
  }
  if (["on", "enable", "true"].includes(value)) {
    return { kind: "set", value: true };
  }
  if (["off", "disable", "false"].includes(value)) {
    return { kind: "set", value: false };
  }
  return { kind: "invalid" };
}

export function formatSteer(message: string): string {
  if (!message.trim()) {
    return "Edit not applied. User declined without feedback. Ask for clarification before retrying.";
  }
  return `Edit not applied. User intercepted the proposed change and provided this feedback:\n\n${message.trim()}\n\nTake this into account. Incorporate this feedback before retrying.`;
}
