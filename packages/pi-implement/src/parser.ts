export type ExecutionMode =
  | { kind: "auto"; planPath: string }
  | { kind: "serial"; planPath: string }
  | { kind: "parallel"; concurrency: number; planPath: string };

export type ParsedCommand =
  | { kind: "execution"; mode: ExecutionMode }
  | {
      kind: "subcommand";
      name:
        | "status"
        | "stop"
        | "cleanup"
        | "config"
        | "init-agents"
        | "inspect"
        | "view";
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
    if (first === "--serial") {
      if (tokens.length !== 2) {
        return {
          kind: "error",
          message: "Usage: /implement --serial <plan-path>",
        };
      }
      const planPath = tokens[1];
      if (planPath.includes(" ")) {
        return {
          kind: "error",
          message: "Plan path must not contain spaces.",
        };
      }
      return {
        kind: "execution",
        mode: { kind: "serial", planPath },
      };
    }

    if (first === "--parallel") {
      if (tokens.length !== 3) {
        return {
          kind: "error",
          message: "Usage: /implement --parallel <n> <plan-path>",
        };
      }
      const concurrency = parsePositiveInt(tokens[1]);
      if (concurrency === undefined) {
        return {
          kind: "error",
          message: "Concurrency must be a positive integer.",
        };
      }
      const planPath = tokens[2];
      if (planPath.includes(" ")) {
        return {
          kind: "error",
          message: "Plan path must not contain spaces.",
        };
      }
      return {
        kind: "execution",
        mode: { kind: "parallel", concurrency, planPath },
      };
    }

    return { kind: "error", message: usage() };
  }

  if (tokens.length === 1) {
    if (
      first === "status" ||
      first === "stop" ||
      first === "cleanup" ||
      first === "config" ||
      first === "init-agents" ||
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

function parsePositiveInt(value: string): number | undefined {
  const n = Number(value);
  if (Number.isInteger(n) && n > 0) {
    return n;
  }
  return undefined;
}

export function usage(): string {
  return (
    "Usage: /implement <plan.md> | /implement --serial <plan.md> | /implement --parallel <n> <plan.md> | " +
    "/implement status | /implement stop | /implement cleanup | /implement config | /implement init-agents | /implement view | /implement inspect"
  );
}
