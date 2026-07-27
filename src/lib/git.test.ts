import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGitInfoExclude } from "./git.js";

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

describe("ensureGitInfoExclude", () => {
  it("preserves existing content while registering normalized patterns exactly once", async () => {
    const root = repo();
    const excludePath = join(root, ".git", "info", "exclude");
    writeFileSync(
      excludePath,
      "# handwritten comment\n*.cache\n/.pi/implement/\n/.pi/implement/\n",
    );

    await ensureGitInfoExclude(root, [
      "/.pi/implement/",
      "/.pi/papercuts.json",
      "/.pi/papercuts.json",
    ]);
    await ensureGitInfoExclude(root, "/.pi/papercuts.json");

    const content = readFileSync(excludePath, "utf-8");
    expect(content).toContain("# handwritten comment\n*.cache\n");
    expect(
      content.split("\n").filter((line) => line === "/.pi/implement/"),
    ).toHaveLength(1);
    expect(
      content.split("\n").filter((line) => line === "/.pi/papercuts.json"),
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
      "/.pi/papercuts.json",
      releasePath,
    );

    let settled = false;
    const update = ensureGitInfoExclude(root, "/.pi/implement/").finally(() => {
      settled = true;
    });
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
    expect(content.split("\n")).toContain("/.pi/papercuts.json");
    expect(content.split("\n")).toContain("/.pi/implement/");
    const anchor = join(
      root,
      ".git",
      "info",
      "pi-extensions-info-exclude.lock",
    );
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
    const worker = await startWorker(root, "/.pi/papercuts.json", releasePath);
    await stop(worker, "SIGKILL");

    await ensureGitInfoExclude(root, "/.pi/implement/");

    const content = readFileSync(excludePath, "utf-8");
    expect(content).toBe("# preserve me\n*.local\n/.pi/implement/\n");
    rmSync(releasePath, { force: true });
  });
});
