import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGitInfoExclude, gitPrimaryWorktreeRoot } from "./git.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const workerPath = fileURLToPath(
  new URL("./git-exclude-worker.cjs", import.meta.url),
);

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-git-exclude-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  return root;
}

function linkedWorktree(root: string): string {
  const worktree = mkdtempSync(join(tmpdir(), "pi-git-exclude-worktree-"));
  roots.push(worktree);
  git(root, "commit", "--allow-empty", "-qm", "initial");
  git(root, "worktree", "add", "-qb", "linked", worktree);
  return worktree;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

async function startWorker(
  cwd: string,
  pattern: string,
  releasePath: string,
): Promise<ChildProcess> {
  const child = spawn(process.execPath, [
    workerPath,
    cwd,
    pattern,
    releasePath,
  ]);
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`Exclude worker did not start for ${cwd}.`)),
      2_000,
    );
    child.once("error", reject);
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      if (output.includes("ready\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      clearTimeout(timeout);
      reject(new Error(`Exclude worker failed: ${chunk.toString("utf-8")}`));
    });
  });
  return child;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    once(child, "exit"),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Exclude worker did not exit.")),
        2_000,
      ),
    ),
  ]);
}

async function stop(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill(signal);
  await waitForExit(child);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stop(child, "SIGTERM")));
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("gitPrimaryWorktreeRoot", () => {
  it("resolves the canonical primary root from linked and detached worktrees", async () => {
    const root = repo();
    git(root, "commit", "--allow-empty", "-qm", "initial");
    const linked = mkdtempSync(join(tmpdir(), "pi git linked "));
    roots.push(linked);
    rmSync(linked, { recursive: true });
    git(root, "worktree", "add", "-qb", "linked", linked);
    git(root, "checkout", "--detach");
    git(linked, "checkout", "--detach");

    await expect(gitPrimaryWorktreeRoot(root)).resolves.toBe(
      realpathSync(root),
    );
    await expect(gitPrimaryWorktreeRoot(linked)).resolves.toBe(
      realpathSync(root),
    );
    await expect(gitPrimaryWorktreeRoot(join(root, "missing"))).rejects.toThrow(
      "primary Git worktree",
    );
  });

  it("resolves named primary and linked worktrees, including porcelain-sensitive paths", async () => {
    const root = repo();
    git(root, "commit", "--allow-empty", "-qm", "initial");
    const linked = mkdtempSync(join(tmpdir(), "pi git linked named "));
    roots.push(linked);
    rmSync(linked, { recursive: true });
    git(root, "worktree", "add", "-qb", "named-linked", linked);

    await expect(gitPrimaryWorktreeRoot(root)).resolves.toBe(
      realpathSync(root),
    );
    await expect(gitPrimaryWorktreeRoot(linked)).resolves.toBe(
      realpathSync(root),
    );
  });

  it("keeps separate clones isolated at their own canonical roots", async () => {
    const root = repo();
    git(root, "commit", "--allow-empty", "-qm", "initial");
    const clone = mkdtempSync(join(tmpdir(), "pi-git-clone-"));
    roots.push(clone);
    rmSync(clone, { recursive: true });
    execFileSync("git", ["clone", "-q", root, clone]);

    await expect(gitPrimaryWorktreeRoot(clone)).resolves.toBe(
      realpathSync(clone),
    );
  });

  it("fails missing, non-worktree, and stale primary locations without fallback or state", async () => {
    const nonWorktree = mkdtempSync(join(tmpdir(), "pi-git-non-worktree-"));
    roots.push(nonWorktree);
    await expect(gitPrimaryWorktreeRoot("")).rejects.toThrow("required");
    await expect(gitPrimaryWorktreeRoot(nonWorktree)).rejects.toThrow(
      "primary Git worktree",
    );
    await expect(
      gitPrimaryWorktreeRoot(join(nonWorktree, "missing")),
    ).rejects.toThrow("primary Git worktree");
    expect(existsSync(join(nonWorktree, ".pi"))).toBe(false);

    const root = repo();
    git(root, "commit", "--allow-empty", "-qm", "initial");
    const linked = linkedWorktree(root);
    const staleRoot = `${root}-moved`;
    roots.push(staleRoot);
    renameSync(root, staleRoot);
    await expect(gitPrimaryWorktreeRoot(linked)).rejects.toThrow();
    expect(existsSync(join(linked, ".pi"))).toBe(false);
  });

  it("rejects a bare repository without creating worktree state", async () => {
    const bare = mkdtempSync(join(tmpdir(), "pi-git-bare-"));
    roots.push(bare);
    git(bare, "init", "--bare", "-q");
    await expect(gitPrimaryWorktreeRoot(bare)).rejects.toThrow();
    expect(existsSync(join(bare, ".pi"))).toBe(false);
  });
});

describe("ensureGitInfoExclude", () => {
  it("preserves existing content while registering normalized patterns exactly once", async () => {
    const root = repo();
    const excludePath = join(root, ".git", "info", "exclude");
    writeFileSync(
      excludePath,
      "# handwritten comment\n*.cache\n/.pi/pipkin/implement/\n/.pi/pipkin/implement/\n",
    );

    await ensureGitInfoExclude(root, [
      "/.pi/pipkin/implement/",
      "/.pi/pipkin/papercuts.json",
      "/.pi/pipkin/papercuts.json",
    ]);
    await ensureGitInfoExclude(root, "/.pi/pipkin/papercuts.json");

    const content = readFileSync(excludePath, "utf-8");
    expect(content).toContain("# handwritten comment\n*.cache\n");
    expect(
      content.split("\n").filter((line) => line === "/.pi/pipkin/implement/"),
    ).toHaveLength(1);
    expect(
      content
        .split("\n")
        .filter((line) => line === "/.pi/pipkin/papercuts.json"),
    ).toHaveLength(1);
  });

  it("re-reads under the common-Git lease across linked checkout processes", async () => {
    const root = repo();
    const linked = linkedWorktree(root);
    const releasePath = join(
      tmpdir(),
      `pi-git-exclude-release-${crypto.randomUUID()}`,
    );
    const worker = await startWorker(
      linked,
      "/.pi/pipkin/papercuts.json",
      releasePath,
    );

    let settled = false;
    const update = ensureGitInfoExclude(root, "/.pi/pipkin/implement/").finally(
      () => {
        settled = true;
      },
    );
    try {
      await delay(50);
      expect(settled).toBe(false);
      writeFileSync(releasePath, "release\n");
      await waitForExit(worker);
      await update;
    } finally {
      writeFileSync(releasePath, "release\n");
      await stop(worker, "SIGTERM");
      rmSync(releasePath, { force: true });
    }

    const excludePath = join(root, ".git", "info", "exclude");
    const content = readFileSync(excludePath, "utf-8");
    expect(content.split("\n")).toContain("/.pi/pipkin/papercuts.json");
    expect(content.split("\n")).toContain("/.pi/pipkin/implement/");
    const anchor = join(root, ".git", "info", "pipkin-info-exclude.lock");
    expect(statSync(anchor).isFile()).toBe(true);
  });

  it("survives a killed production writer without publishing partial content", async () => {
    const root = repo();
    const excludePath = join(root, ".git", "info", "exclude");
    writeFileSync(excludePath, "# preserve me\n*.local\n");
    const releasePath = join(
      tmpdir(),
      `pi-git-exclude-release-${crypto.randomUUID()}`,
    );
    const worker = await startWorker(
      root,
      "/.pi/pipkin/papercuts.json",
      releasePath,
    );
    await stop(worker, "SIGKILL");

    await ensureGitInfoExclude(root, "/.pi/pipkin/implement/");

    const content = readFileSync(excludePath, "utf-8");
    expect(content).toBe("# preserve me\n*.local\n/.pi/pipkin/implement/\n");
    rmSync(releasePath, { force: true });
  });
});
