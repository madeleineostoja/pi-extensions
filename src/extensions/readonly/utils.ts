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

const MAX_TARGET_DISPLAY_LENGTH = 120;
const CONTROL_PATTERN = /\p{C}/gu;

export function formatReadonlyTarget(
  path: string | undefined,
): string | undefined {
  const normalized = path
    ?.replace(CONTROL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= MAX_TARGET_DISPLAY_LENGTH) {
    return normalized;
  }
  let prefix = "";
  for (const character of normalized) {
    if (prefix.length + character.length >= MAX_TARGET_DISPLAY_LENGTH) {
      break;
    }
    prefix += character;
  }
  return `${prefix}…`;
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
