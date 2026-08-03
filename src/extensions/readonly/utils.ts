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

export function formatSteerTitle(path: string | undefined): string {
  return path ? `Steer the agent — ${path}` : "Steer the agent";
}

export function formatProposalDetail(
  tool: "write" | "edit",
  path: string | undefined,
  input: unknown,
): string {
  const boundedText = (value: string, limit: number) =>
    Array.from(value, (character) =>
      /\p{C}/u.test(character) ? "�" : character,
    )
      .join("")
      .slice(0, limit);
  const target = boundedText(path ?? "an unspecified path", 256);
  const raw =
    input && typeof input === "object"
      ? tool === "write"
        ? (input as { content?: unknown }).content
        : (input as { edits?: unknown }).edits
      : undefined;
  let proposal = "";
  try {
    proposal =
      typeof raw === "string"
        ? raw
        : raw === undefined
          ? ""
          : (JSON.stringify(raw) ?? "");
  } catch {}
  const bounded = boundedText(proposal, 3_000);
  return bounded
    ? `Proposed ${tool} for ${target}:\n\n${bounded}`
    : `Proposed ${tool} for ${target}.`;
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
