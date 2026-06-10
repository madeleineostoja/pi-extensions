export type ParsedCommand =
  | { kind: "execution"; mode: { kind: "auto"; planPath: string } }
  | {
      kind: "subcommand";
      name: "status" | "stop" | "cleanup" | "config" | "inspect" | "view";
    }
  | { kind: "error"; message: string };

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return { kind: "error", message: usage() };
  }

  // Early check: any space-containing token that isn't a known subcommand is an error
  const tokens = tokenize(trimmed);
  const first = tokens[0];

  if (first.startsWith("-")) {
    return { kind: "error", message: usage() };
  }

  if (tokens.length === 1) {
    if (
      first === "status" ||
      first === "stop" ||
      first === "cleanup" ||
      first === "config" ||
      first === "inspect" ||
      first === "view"
    ) {
      return { kind: "subcommand", name: first };
    }
    if (first.includes(" ")) {
      return {
        kind: "error",
        message: "Plan path must not contain spaces.",
      };
    }
    return {
      kind: "execution",
      mode: { kind: "auto", planPath: first },
    };
  }

  return { kind: "error", message: usage() };
}

function tokenize(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

export function usage(): string {
  return "Usage: /implement <plan.md> | /implement status | /implement stop | /implement cleanup | /implement config | /implement view | /implement inspect";
}
