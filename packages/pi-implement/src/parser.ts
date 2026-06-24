export type ParsedCommand =
  | {
      kind: "execution";
      mode: { kind: "auto"; planPath: string; forceSerial: boolean };
    }
  | {
      kind: "control";
      name: "status" | "stop" | "cleanup" | "config" | "inspect" | "view";
    }
  | { kind: "error"; message: string };

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return { kind: "error", message: usage() };
  }

  const tokens = tokenize(trimmed);
  const first = tokens[0];

  if (first.startsWith(":")) {
    const name = first.slice(1);
    if (
      tokens.length === 1 &&
      (name === "status" ||
        name === "stop" ||
        name === "cleanup" ||
        name === "config" ||
        name === "inspect" ||
        name === "view")
    ) {
      return { kind: "control", name };
    }
    return { kind: "error", message: usage() };
  }

  if (first.startsWith("-")) {
    return { kind: "error", message: usage() };
  }

  if (tokens.length === 1) {
    return {
      kind: "execution",
      mode: { kind: "auto", planPath: first, forceSerial: false },
    };
  }

  if (tokens.length === 2 && tokens[1] === "--serial") {
    if (first.includes(" ")) {
      return {
        kind: "error",
        message: "Plan path must not contain spaces.",
      };
    }
    return {
      kind: "execution",
      mode: { kind: "auto", planPath: first, forceSerial: true },
    };
  }

  return { kind: "error", message: usage() };
}

function tokenize(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

export function usage(): string {
  return "Usage: /implement to choose an action, or /implement <plan.md> [--serial] to start directly";
}
