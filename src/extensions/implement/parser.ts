export type ParsedCommand =
  | {
      kind: "execution";
      planPath: string;
      restart?: { runId: string };
    }
  | {
      kind: "control";
      name: "status" | "stop" | "cleanup" | "cleanup-completed" | "inspect";
      runId?: string;
    }
  | { kind: "error"; message: string };

export function parseCommand(input: string): ParsedCommand {
  const [subcommand, ...args] = tokenize(input);

  if (subcommand === "restart" && args.length === 2) {
    return {
      kind: "execution",
      planPath: args[0]!,
      restart: { runId: args[1]! },
    };
  }
  if ((subcommand === "status" || subcommand === "stop") && args.length === 0) {
    return { kind: "control", name: subcommand };
  }
  if (
    (subcommand === "inspect" || subcommand === "cleanup") &&
    args.length === 1
  ) {
    return { kind: "control", name: subcommand, runId: args[0] };
  }
  if (
    subcommand &&
    args.length === 0 &&
    !subcommand.startsWith(":") &&
    !subcommand.startsWith("-")
  ) {
    return { kind: "execution", planPath: subcommand };
  }
  return { kind: "error", message: usage() };
}

function tokenize(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

export function usage(): string {
  return "Usage: /implement <plan.md> | restart <plan.md> <completed-run-id> | status | inspect <run-id> | cleanup <run-id> | stop";
}
