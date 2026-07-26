export type ParsedCommand =
  | {
      kind: "execution";
      planPath: string;
      recovery?: { kind: "resume" | "start-over"; runId: string };
    }
  | {
      kind: "control";
      name: "status" | "stop" | "cleanup" | "inspect";
      runId?: string;
    }
  | { kind: "error"; message: string };

export function parseCommand(input: string): ParsedCommand {
  const [subcommand, ...args] = tokenize(input);

  if (subcommand === "run" && args.length === 1) {
    return { kind: "execution", planPath: args[0]! };
  }
  if (
    (subcommand === "resume" || subcommand === "restart") &&
    args.length === 2
  ) {
    return {
      kind: "execution",
      planPath: args[0]!,
      recovery: {
        kind: subcommand === "resume" ? "resume" : "start-over",
        runId: args[1]!,
      },
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
  return { kind: "error", message: usage() };
}

function tokenize(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

export function usage(): string {
  return "Usage: /implement run <plan.md> | resume <plan.md> <run-id> | restart <plan.md> <run-id> | status | inspect <run-id> | cleanup <run-id> | stop";
}
