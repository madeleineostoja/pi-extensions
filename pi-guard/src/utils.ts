const DEFAULT_GUARD_TOOLS = ["edit", "write"] as const;

export function parseGuardTools(value: string | undefined): {
  tools: Set<string>;
  usedDefault: boolean;
} {
  if (value === undefined) {
    return { tools: new Set(DEFAULT_GUARD_TOOLS), usedDefault: false };
  }
  const tokens = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return { tools: new Set(DEFAULT_GUARD_TOOLS), usedDefault: true };
  }
  return { tools: new Set(tokens), usedDefault: false };
}

export type GuardAction =
  | { kind: "toggle" }
  | { kind: "set"; value: boolean }
  | { kind: "status" }
  | { kind: "invalid" };

export function extractToolPath(input: unknown): string | undefined {
  if (input !== null && typeof input === "object") {
    const p = (input as Record<string, unknown>).path;
    if (typeof p === "string" && p.length > 0) return p;
  }
  return undefined;
}

export function formatModalTitle(toolName: string, path: string | undefined): string {
  if (path) return `Guard: ${toolName} ${path} — apply?`;
  return `Guard: ${toolName} — apply?`;
}

export function formatSteerTitle(path: string | undefined): string {
  if (path) return `Steer the agent — ${path}`;
  return "Steer the agent";
}

const GUARD_SET_MAP: Record<string, boolean> = {
  on: true, enable: true, true: true,
  off: false, disable: false, false: false,
};

export function parseGuardArgs(args: string): GuardAction {
  const token = args.trim().toLowerCase();
  if (token === "") return { kind: "toggle" };
  if (Object.hasOwn(GUARD_SET_MAP, token)) return { kind: "set", value: GUARD_SET_MAP[token] };
  if (token === "status") return { kind: "status" };
  return { kind: "invalid" };
}

export function formatSteer(message: string): string {
  if (message.trim() === "") {
    return "Edit not applied. User declined without feedback. Ask for clarification before retrying.";
  }
  return `Edit not applied. User intercepted the proposed change and provided this feedback:\n\n${message.trim()}\n\nTake this into account. Incorporate this feedback before retrying.`;
}
