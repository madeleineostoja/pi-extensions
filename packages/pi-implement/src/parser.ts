export type ParsedCommand =
  | {
      kind: "execution";
      planPath: string;
      recovery?: { kind: "resume"; runId: string };
    }
  | {
      kind: "control";
      name: "status" | "stop" | "cleanup" | "config" | "inspect" | "view";
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

  const flags = tokens.slice(1);
  let recovery: { kind: "resume"; runId: string } | undefined;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--resume" && !recovery) {
      const runId = flags[++index];
      if (!runId || runId.startsWith("--")) {
        return { kind: "error", message: usage() };
      }
      recovery = {
        kind: "resume",
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
  return "Usage: /implement <plan.md> [--resume <run-id>], or /implement :stop";
}
