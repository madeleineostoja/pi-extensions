export type GuardAction =
  | { kind: "toggle" }
  | { kind: "set"; value: boolean }
  | { kind: "invalid" };

export function parseGuardArgs(args: string): GuardAction {
  const token = args.trim().toLowerCase();
  if (token === "") return { kind: "toggle" };
  if (token === "on" || token === "enable" || token === "true")
    return { kind: "set", value: true };
  if (token === "off" || token === "disable" || token === "false")
    return { kind: "set", value: false };
  return { kind: "invalid" };
}

export function formatBlockReason(message: string): string {
  if (message.trim() === "") {
    return "Command blocked by user. Do not retry the same command without addressing the user's concern or asking for clarification.";
  }
  return `Command blocked by user. User feedback:\n\n${message.trim()}\n\nAddress this before retrying.`;
}
