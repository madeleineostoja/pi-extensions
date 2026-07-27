import { execFileSync } from "node:child_process";

export type GitRecoverability =
  | "tracked-clean"
  | "tracked-dirty"
  | "untracked"
  | "not-git";

export function isInsideWorkTree(cwd: string): boolean {
  try {
    const result = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    return result.trim() === "true";
  } catch {
    return false;
  }
}

export function gitStatusPorcelain(cwd: string, path?: string): string {
  try {
    const args = ["status", "--porcelain=v1"];
    if (path) {
      args.push("--", path);
    }
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
  } catch {
    return "";
  }
}

export function gitLsFiles(cwd: string, path?: string): string {
  try {
    const args = ["ls-files"];
    if (path) {
      args.push("--", path);
    }
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
  } catch {
    return "";
  }
}

export function gitWorktreeRoot(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
  } catch {
    return undefined;
  }
}

export function classifyGitRecoverability(
  cwd: string,
  absPath: string,
): GitRecoverability {
  if (!isInsideWorkTree(cwd)) {
    return "not-git";
  }

  const status = gitStatusPorcelain(cwd, absPath);
  const lines = status.split("\n").filter(Boolean);

  for (const line of lines) {
    const prefix = line.slice(0, 2);
    if (prefix === "??") {
      return "untracked";
    }
    if (/^[ MADRCU?]{2}/.test(prefix)) {
      return "tracked-dirty";
    }
  }

  const ls = gitLsFiles(cwd, absPath);
  if (ls.trim().length > 0) {
    return "tracked-clean";
  }

  return "not-git";
}

export function hasDirtyWorktree(cwd: string): boolean {
  try {
    const out = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    return out.trim().length > 0;
  } catch {
    return true;
  }
}
