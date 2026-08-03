import { execFile } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { acquireFileLease } from "./file-lease.js";

const execFileAsync = promisify(execFile);
const excludeLeaseName = "pipkin-info-exclude.lock";
const excludeLeaseTimeoutMs = 10_000;

let testHooks: GitInfoExcludeTestHooks | undefined;

type GitInfoExcludeTestHooks = {
  beforeRename?(): Promise<void>;
};

export function setGitInfoExcludeTestHooks(
  hooks: GitInfoExcludeTestHooks | undefined,
): void {
  testHooks = hooks;
}

export async function gitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd },
  );
  return stdout.trim();
}

export async function gitPrimaryWorktreeRoot(cwd: string): Promise<string> {
  if (!cwd) {
    throw new Error(
      "A working directory is required to resolve the primary worktree.",
    );
  }
  let stdout: Buffer;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain", "-z"],
      { cwd, encoding: "buffer" },
    ));
  } catch (error) {
    throw new Error("Could not resolve a primary Git worktree.", {
      cause: error,
    });
  }
  const entries = stdout.toString("utf8").split("\0").filter(Boolean);
  if (entries.includes("bare")) {
    throw new Error("Git repository is bare and has no primary worktree.");
  }
  const primary = entries.find((entry) => entry.startsWith("worktree "));
  if (!primary) {
    throw new Error("Git did not report a primary worktree.");
  }
  const path = primary.slice("worktree ".length);
  if (!path) {
    throw new Error("Git reported an invalid primary worktree path.");
  }
  try {
    return await realpath(path);
  } catch (error) {
    throw new Error("Git reported a missing primary worktree path.", {
      cause: error,
    });
  }
}

export async function ensureGitInfoExclude(
  cwd: string,
  patterns: string | readonly string[],
): Promise<void> {
  const requested = normalizePatterns(patterns);
  const commonDir = await gitCommonDir(cwd);
  const infoDir = join(commonDir, "info");
  const excludePath = join(infoDir, "exclude");
  const leasePath = join(infoDir, excludeLeaseName);
  await mkdir(infoDir, { recursive: true });

  const lease = await acquireFileLease(leasePath, {
    timeoutMs: excludeLeaseTimeoutMs,
  });
  try {
    const content = await readExclude(excludePath);
    const nextContent = mergePatterns(content, requested);
    if (nextContent !== content) {
      await replaceFileAtomically(excludePath, nextContent);
    }
  } finally {
    await lease.release();
  }
}

function normalizePatterns(patterns: string | readonly string[]): string[] {
  const values = typeof patterns === "string" ? [patterns] : patterns;
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("At least one Git info/exclude pattern is required.");
  }

  const normalized = new Set<string>();
  for (const pattern of values) {
    if (
      typeof pattern !== "string" ||
      pattern.length === 0 ||
      pattern.includes("\n") ||
      pattern.includes("\r")
    ) {
      throw new TypeError(
        "Git info/exclude patterns must be non-empty single lines.",
      );
    }
    normalized.add(pattern);
  }
  return [...normalized];
}

async function readExclude(excludePath: string): Promise<string> {
  try {
    return await readFile(excludePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw new Error(`Could not read Git info/exclude at ${excludePath}.`, {
      cause: error,
    });
  }
}

function mergePatterns(content: string, patterns: readonly string[]): string {
  const requested = new Set(patterns);
  const seen = new Set<string>();
  const lines = content.length === 0 ? [] : content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }

  const retained = lines.filter((line) => {
    if (!requested.has(line)) {
      return true;
    }
    if (seen.has(line)) {
      return false;
    }
    seen.add(line);
    return true;
  });
  for (const pattern of patterns) {
    if (!seen.has(pattern)) {
      retained.push(pattern);
    }
  }
  return `${retained.join("\n")}\n`;
}

async function replaceFileAtomically(
  path: string,
  content: string,
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    const mode = await existingMode(path);
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await testHooks?.beforeRename?.();
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    throw new Error(
      `Could not atomically update Git info/exclude at ${path}.`,
      {
        cause: error,
      },
    );
  } finally {
    await handle?.close();
    await unlink(temporaryPath).catch(() => {});
  }
}

async function existingMode(path: string): Promise<number> {
  try {
    return (await stat(path)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0o666;
    }
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
