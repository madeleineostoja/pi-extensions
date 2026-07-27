import { existsSync } from "node:fs";
import { toAbsolutePath } from "./paths";

export type PendingCreations = Map<string, Set<string>>;

export function extractPendingCreations(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  pending: PendingCreations,
): void {
  if (toolName === "write") {
    const path = input.path;
    if (typeof path === "string") {
      const abs = toAbsolutePath(path, cwd);
      if (existsSync(abs)) {
        return;
      }
      const set = pending.get(toolCallId) ?? new Set<string>();
      set.add(abs);
      pending.set(toolCallId, set);
    }
    return;
  }

  if (toolName !== "bash") {
    return;
  }

  const command = (input as { command?: string }).command;
  if (typeof command !== "string") {
    return;
  }

  const words = command.trim().split(/\s+/);
  const cmd = words[0];

  if (cmd === "touch" || cmd === "mkdir" || cmd === "mkdirp") {
    const paths = words.slice(1).filter((w) => !w.startsWith("-"));
    if (paths.length > 0) {
      const set = pending.get(toolCallId) ?? new Set<string>();
      for (const p of paths) {
        const abs = toAbsolutePath(p, cwd);
        if (!existsSync(abs)) {
          set.add(abs);
        }
      }
      if (set.size > 0) {
        pending.set(toolCallId, set);
      }
    }
    return;
  }

  // Simple truncating redirect to a single file: e.g. "> file" or "echo x > file"
  const redirectMatch = command.match(
    /(?:^|\s)>(?!>)\s*(["']?)([^"'\s;|&]+)\1(?:\s|$)/,
  );
  if (redirectMatch) {
    const p = redirectMatch[2];
    const abs = toAbsolutePath(p, cwd);
    if (existsSync(abs)) {
      return;
    }
    const set = pending.get(toolCallId) ?? new Set<string>();
    set.add(abs);
    pending.set(toolCallId, set);
  }
}

export function commitPendingCreations(
  toolCallId: string,
  pending: PendingCreations,
  committed: Set<string>,
  isError: boolean,
): void {
  const set = pending.get(toolCallId);
  if (!set) {
    return;
  }
  pending.delete(toolCallId);
  if (!isError) {
    for (const p of set) {
      committed.add(p);
    }
  }
}
