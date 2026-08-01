import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pathIsWithin, type SandboxPolicy } from "./policy.js";

export type DirectWriteDecision =
  | Readonly<{ kind: "allow"; target: string }>
  | Readonly<{ kind: "deny"; reason: string; target?: string }>;

const unicodeSpaces = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function components(path: string): string[] {
  const root = parse(path).root;
  return path.slice(root.length).split(sep).filter(Boolean);
}

function resolvePiToolPath(rawPath: string, sessionCwd: string): string {
  let normalized = rawPath.replace(unicodeSpaces, " ");
  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (normalized === "~") {
    return homedir();
  }
  if (normalized.startsWith("~/")) {
    return join(homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("file://")) {
    return fileURLToPath(normalized);
  }
  return resolve(sessionCwd, normalized);
}

export function effectiveTarget(rawPath: string, sessionCwd: string): string {
  if (!rawPath || rawPath.includes("\0")) {
    throw new Error("invalid path");
  }
  const initial = resolvePiToolPath(rawPath, sessionCwd);
  let current = parse(initial).root;
  const pending = components(initial);
  let links = 0;
  while (pending.length) {
    const component = pending.shift()!;
    if (component === ".") {
      continue;
    }
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, component);
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      return resolve(candidate, ...pending);
    }
    if (!stat.isSymbolicLink()) {
      current = candidate;
      continue;
    }
    if (++links > 40) {
      throw new Error("too many symbolic links");
    }
    const target = readlinkSync(candidate);
    const linked = isAbsolute(target)
      ? target
      : join(dirname(candidate), target);
    current = parse(linked).root;
    pending.unshift(...components(linked));
  }
  try {
    return realpathSync(current);
  } catch {
    return current;
  }
}

export function decideDirectWrite(
  rawPath: unknown,
  policy: SandboxPolicy,
): DirectWriteDecision {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { kind: "deny", reason: "Sandbox: filesystem path is required." };
  }
  try {
    const target = effectiveTarget(rawPath, policy.sessionCwd);
    return pathIsWithin(target, policy.workspaceRoot)
      ? { kind: "allow", target }
      : {
          kind: "deny",
          reason: "Sandbox: direct writes must stay in the workspace.",
          target,
        };
  } catch {
    return { kind: "deny", reason: "Sandbox: filesystem path is invalid." };
  }
}

export function decideDirectMutation(
  options: Readonly<{
    tool: "write" | "edit";
    input: Readonly<{ path?: unknown }>;
    policy: SandboxPolicy;
  }>,
): DirectWriteDecision {
  return decideDirectWrite(options.input.path, options.policy);
}
