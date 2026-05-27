export type ReadonlyAction =
  | { kind: "toggle" }
  | {
      kind: "set";
      value: boolean;
    }
  | { kind: "invalid" };

export function extractToolPath(input: unknown): string | undefined {
  if (input !== null && typeof input === "object") {
    const p = (input as Record<string, unknown>).path;
    if (typeof p === "string" && p.length > 0) return p;
  }
  return undefined;
}

export function formatModalTitle(
  toolName: string,
  path: string | undefined,
): string {
  if (path) return `Readonly: ${toolName} ${path} — apply?`;
  return `Readonly: ${toolName} — apply?`;
}

export function formatSteerTitle(path: string | undefined): string {
  if (path) return `Steer the agent — ${path}`;
  return "Steer the agent";
}

const READONLY_SET_MAP: Record<string, boolean> = {
  on: true,
  enable: true,
  true: true,
  off: false,
  disable: false,
  false: false,
};

export function parseReadonlyArgs(args: string): ReadonlyAction {
  const token = args.trim().toLowerCase();
  if (token === "") return { kind: "toggle" };
  if (Object.hasOwn(READONLY_SET_MAP, token))
    return { kind: "set", value: READONLY_SET_MAP[token] };
  return { kind: "invalid" };
}

export function formatSteer(message: string): string {
  if (message.trim() === "") {
    return "Edit not applied. User declined without feedback. Ask for clarification before retrying.";
  }
  return `Edit not applied. User intercepted the proposed change and provided this feedback:\n\n${message.trim()}\n\nTake this into account. Incorporate this feedback before retrying.`;
}
