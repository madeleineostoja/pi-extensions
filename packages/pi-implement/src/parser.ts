export type ParsedCommand =
  | {
      kind: "execution";
      planPath: string;
      recovery?: { kind: "resume" | "start-over"; runId: string };
    }
  | {
      kind: "control";
      name:
        | "status"
        | "stop"
        | "cleanup"
        | "abandon"
        | "config"
        | "inspect"
        | "view";
      runId?: string;
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
      (tokens.length === 1 || (tokens.length === 2 && tokens[1])) &&
      (name === "status" ||
        name === "stop" ||
        name === "cleanup" ||
        name === "abandon" ||
        name === "config" ||
        name === "inspect" ||
        name === "view")
    ) {
      return {
        kind: "control",
        name,
        ...(tokens[1] ? { runId: tokens[1] } : {}),
      };
    }
    return { kind: "error", message: usage() };
  }

  if (first.startsWith("-")) {
    return { kind: "error", message: usage() };
  }

  const flags = tokens.slice(1);
  let recovery: { kind: "resume" | "start-over"; runId: string } | undefined;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if ((flag === "--resume" || flag === "--start-over") && !recovery) {
      const runId = flags[++index];
      if (!runId || runId.startsWith("--")) {
        return { kind: "error", message: usage() };
      }
      recovery = {
        kind: flag === "--resume" ? "resume" : "start-over",
        runId,
      };
      continue;
    }
    return { kind: "error", message: usage() };
  }
  return {
    kind: "execution",
    planPath: first,
    ...(recovery ? { recovery } : {}),
  };
}

function tokenize(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

export function usage(): string {
  return "Usage: /implement <plan.md> [--resume <run-id> | --start-over <run-id>], or /implement :status | :inspect <run-id> | :cleanup <run-id> | :abandon <run-id> | :stop";
}
