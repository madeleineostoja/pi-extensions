import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecGitClient } from "./git.js";
import { GitProcess } from "./git-process.js";
import {
  observePromise,
  settle,
  settleAll,
  waitForCondition,
  within,
} from "./test-boundary.js";

const temporaryDirectories = new Set<string>();

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.add(path);
  return path;
}

function repo(): string {
  const cwd = temporaryDirectory("pipkin-implement-git-");
  git(cwd, "init");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  writeFileSync(join(cwd, "tracked.ts"), "export const value = 1;\n");
  git(cwd, "add", "tracked.ts");
  git(cwd, "commit", "-m", "chore: init");
  return cwd;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

afterEach(() => {
  for (const path of temporaryDirectories) {
    rmSync(path, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function holdAlias(script: string): string {
  return `alias.hold=!${process.execPath} ${script}`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("git helpers", () => {
  it("serializes index-sensitive Git commands in one checkout", async () => {
    const cwd = repo();
    const dir = temporaryDirectory("pipkin-implement-git-hold-");
    const marker = join(dir, "marker");
    const release = join(dir, "release");
    const script = join(dir, "hold.mjs");
    writeFileSync(
      script,
      `import { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { setTimeout } from "node:timers/promises";\nconst [marker, release, id] = process.argv.slice(2);\nconst finished = marker + ".first-finished";\nif (id === "first") {\n  appendFileSync(marker, id + "\\n");\n  while (!existsSync(release)) await setTimeout(5);\n  writeFileSync(finished, "done");\n} else {\n  if (!existsSync(finished)) process.exit(23);\n  appendFileSync(marker, id + "\\n");\n}\n`,
    );
    const process = new GitProcess(cwd);
    const first = process.run(
      ["-c", holdAlias(script), "hold", marker, release, "first"],
      { cwd },
    );
    const firstObservation = observePromise("first command", first);
    let second: Promise<unknown> | undefined;
    try {
      await waitForCondition(
        "first command startup",
        () => existsSync(marker),
        {
          diagnostics: firstObservation.describe,
          observations: [firstObservation],
        },
      );
      second = process.run(
        ["-c", holdAlias(script), "hold", marker, release, "second"],
        { cwd },
      );
      writeFileSync(release, "go");
      await within("both checkout commands", Promise.all([first, second]), {
        diagnostics: firstObservation.describe,
      });
      expect(readFileSync(marker, "utf-8")).toBe("first\nsecond\n");
    } finally {
      writeFileSync(release, "go");
      await settleAll([
        settle("first command", first, {
          diagnostics: firstObservation.describe,
        }),
        ...(second ? [settle("second command", second)] : []),
        settle("checkout queue", process.onIdle()),
      ]);
    }
  });

  it("allows separate linked worktree checkout queues to overlap", async () => {
    const cwd = repo();
    const linked = join(
      temporaryDirectory("pipkin-implement-linked-"),
      "linked",
    );
    git(cwd, "worktree", "add", "-b", "linked", linked);
    const dir = temporaryDirectory("pipkin-implement-git-hold-");
    const marker = join(dir, "marker");
    const release = join(dir, "release");
    const script = join(dir, "hold.mjs");
    writeFileSync(
      script,
      `import { appendFileSync, existsSync } from "node:fs";\nimport { setTimeout } from "node:timers/promises";\nconst [marker, release, id] = process.argv.slice(2);\nappendFileSync(marker, id + "\\n");\nwhile (!existsSync(release)) await setTimeout(5);\n`,
    );
    const mainProcess = new GitProcess(cwd);
    const linkedProcess = new GitProcess(linked);
    const first = mainProcess.run(
      ["-c", holdAlias(script), "hold", marker, release, "main"],
      { cwd },
    );
    const second = linkedProcess.run(
      ["-c", holdAlias(script), "hold", marker, release, "linked"],
      { cwd: linked },
    );
    const firstObservation = observePromise("main command", first);
    const secondObservation = observePromise("linked command", second);
    try {
      await waitForCondition(
        "both linked checkout commands to start",
        () =>
          existsSync(marker) &&
          readFileSync(marker, "utf-8").split("\n").filter(Boolean).length ===
            2,
        {
          diagnostics: () =>
            `${firstObservation.describe()}; ${secondObservation.describe()}`,
          observations: [firstObservation, secondObservation],
        },
      );
      writeFileSync(release, "go");
      await within(
        "both linked checkout commands",
        Promise.all([first, second]),
        {
          diagnostics: () =>
            `${firstObservation.describe()}; ${secondObservation.describe()}`,
        },
      );
    } finally {
      writeFileSync(release, "go");
      await settleAll([
        settle("main command", first, {
          diagnostics: firstObservation.describe,
        }),
        settle("linked command", second, {
          diagnostics: secondObservation.describe,
        }),
        settle(
          "linked checkout queues",
          Promise.all([mainProcess.onIdle(), linkedProcess.onIdle()]),
        ),
      ]);
      git(cwd, "worktree", "remove", "--force", linked);
    }
  });

  it("serializes shared worktree metadata operations per common repository", async () => {
    const cwd = repo();
    const linked = join(
      temporaryDirectory("pipkin-implement-linked-"),
      "linked",
    );
    git(cwd, "worktree", "add", "-b", "linked", linked);
    const dir = temporaryDirectory("pipkin-implement-git-hold-");
    const marker = join(dir, "marker");
    const release = join(dir, "release");
    const script = join(dir, "hold.mjs");
    writeFileSync(
      script,
      `import { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { setTimeout } from "node:timers/promises";\nconst [marker, release, id] = process.argv.slice(2);\nconst finished = marker + ".first-finished";\nif (id === "main") {\n  appendFileSync(marker, id + "\\n");\n  while (!existsSync(release)) await setTimeout(5);\n  writeFileSync(finished, "done");\n} else {\n  if (!existsSync(finished)) process.exit(23);\n  appendFileSync(marker, id + "\\n");\n}\n`,
    );
    const mainProcess = new GitProcess(cwd);
    const linkedProcess = new GitProcess(linked);
    const first = mainProcess.run(
      ["-c", holdAlias(script), "hold", marker, release, "main"],
      { cwd, scope: "repository" },
    );
    const firstObservation = observePromise("main command", first);
    let second: Promise<unknown> | undefined;
    try {
      await waitForCondition("main command startup", () => existsSync(marker), {
        diagnostics: firstObservation.describe,
        observations: [firstObservation],
      });
      second = linkedProcess.run(
        ["-c", holdAlias(script), "hold", marker, release, "linked"],
        { cwd: linked, scope: "repository" },
      );
      writeFileSync(release, "go");
      await within("both repository commands", Promise.all([first, second]), {
        diagnostics: firstObservation.describe,
      });
    } finally {
      writeFileSync(release, "go");
      await settleAll([
        settle("main command", first, {
          diagnostics: firstObservation.describe,
        }),
        ...(second ? [settle("linked command", second)] : []),
        settle(
          "common repository queues",
          Promise.all([mainProcess.onIdle(), linkedProcess.onIdle()]),
        ),
      ]);
      git(cwd, "worktree", "remove", "--force", linked);
    }
  });

  it("cancels an owned Git child before its queue and fixture settle", async () => {
    const cwd = repo();
    const dir = temporaryDirectory("pipkin-implement-git-cancel-");
    const marker = join(dir, "marker");
    const pidPath = join(dir, "pid");
    const exitPath = join(dir, "exited");
    const release = join(dir, "release");
    const script = join(dir, "hold.mjs");
    writeFileSync(
      script,
      `import { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { setTimeout } from "node:timers/promises";\nconst [marker, pidPath, exitPath, release] = process.argv.slice(2);\nprocess.on("SIGTERM", () => { writeFileSync(exitPath, String(process.pid)); process.exit(0); });\nwriteFileSync(pidPath, String(process.pid));\nappendFileSync(marker, "started\\n");\nwhile (!existsSync(release)) await setTimeout(5);\n`,
    );
    const controller = new AbortController();
    const process = new GitProcess(cwd);
    const command = process.run(
      ["-c", holdAlias(script), "hold", marker, pidPath, exitPath, release],
      { cwd, signal: controller.signal },
    );
    const observation = observePromise("cancelled command", command);
    let childPid: number | undefined;
    try {
      await waitForCondition(
        "owned Git child startup",
        () => existsSync(marker),
        {
          diagnostics: observation.describe,
          observations: [observation],
        },
      );
      const startedChildPid = Number(readFileSync(pidPath, "utf-8"));
      childPid = startedChildPid;
      controller.abort();
      await expect(
        within("cancelled command", command, {
          diagnostics: observation.describe,
        }),
      ).rejects.toMatchObject({
        failure: { kind: "cancelled" },
      });
      await within("cancelled Git queue", process.onIdle(), {
        diagnostics: observation.describe,
      });
      await waitForCondition(
        "owned Git child exit acknowledgement",
        () => {
          try {
            return readFileSync(exitPath, "utf-8") === String(startedChildPid);
          } catch {
            return false;
          }
        },
        { diagnostics: observation.describe },
      );
    } finally {
      writeFileSync(release, "go");
      controller.abort();
      if (childPid && !existsSync(exitPath) && processIsAlive(childPid)) {
        globalThis.process.kill(childPid, "SIGKILL");
      }
      await settleAll([
        settle("cancelled command", command, {
          diagnostics: observation.describe,
        }),
        settle("cancelled Git queue", process.onIdle(), {
          diagnostics: observation.describe,
        }),
      ]);
    }
  });

  it("reports a prematurely exiting Git child without waiting for the suite timeout", async () => {
    const cwd = repo();
    const dir = temporaryDirectory("pipkin-implement-git-exit-");
    const script = join(dir, "exit.mjs");
    writeFileSync(
      script,
      `console.error("child exited before startup"); process.exit(23);\n`,
    );

    await expect(
      within(
        "prematurely exiting Git child",
        new GitProcess(cwd).run(["-c", holdAlias(script), "hold"], { cwd }),
      ),
    ).rejects.toThrow("child exited before startup");
  });

  it("returns typed evidence for an index lock", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, ".git", "index.lock"), "held");
    await expect(
      new GitProcess(cwd).run(["write-tree"], { cwd }),
    ).rejects.toMatchObject({
      failure: { kind: "lock_busy", command: "git write-tree" },
    });
  });

  it("retries an idempotent index operation after a transient lock", async () => {
    const cwd = repo();
    const lock = join(cwd, ".git", "index.lock");
    writeFileSync(lock, "held");
    const process = new GitProcess(cwd, {
      retryDelay: async () => {
        rmSync(lock);
      },
    });

    await expect(
      process.run(["write-tree"], { cwd, retry: "idempotent" }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("detects rebase directory state as an active operation", async () => {
    const cwd = repo();
    mkdirSync(join(cwd, ".git", "rebase-merge"));
    const client = new ExecGitClient(cwd);

    expect(await client.activeOperation()).toBe("rebase");
  });

  it("treats worktree as clean except known plan artifacts", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "plan.md"), "# Plan\n");
    writeFileSync(join(cwd, "tracked.ts"), "export const value = 2;\n");
    const client = new ExecGitClient(cwd);

    expect(await client.isCleanExcept([join(cwd, "plan.md")])).toBe(false);
    expect(await client.statusEntriesExcept([join(cwd, "plan.md")])).toEqual([
      { status: " M", path: "tracked.ts" },
    ]);
    expect(await client.resolveCommit((await client.head()).slice(0, 12))).toBe(
      await client.head(),
    );
    git(cwd, "checkout", "--", "tracked.ts");
    expect(await client.isCleanExcept([join(cwd, "plan.md")])).toBe(true);
  });

  it("restores reviewer worktree edits from the staged index", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "tracked.ts"), "export const value = 2;\n");
    const client = new ExecGitClient(cwd);
    git(cwd, "add", "-A");
    const before = await client.worktreeFingerprintExcept([]);
    writeFileSync(join(cwd, "tracked.ts"), "export const value = 3;\n");
    writeFileSync(join(cwd, "reviewer.tmp"), "oops\n");

    await client.restoreWorktreeFromIndexExcept([]);

    expect(await client.worktreeFingerprintExcept([])).toBe(before);
    expect(git(cwd, "status", "--porcelain")).toBe("M  tracked.ts\n");
  });

  it("creates checkpoints through ordinary commit hooks", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const marker = join(cwd, "hook-ran");
    const hook = join(cwd, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\necho ran >> ${marker}\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(cwd, "tracked.ts"), "export const value = 2;\n");
    git(cwd, "add", "-A");
    expect(
      (await client.checkpoint("pipkin:implement: candidate", false)).exitCode,
    ).toBe(0);
    const first = await client.head();

    writeFileSync(join(cwd, "next.ts"), "export const next = true;\n");
    git(cwd, "add", "-A");
    expect(
      (await client.checkpoint("pipkin:implement: candidate", true)).exitCode,
    ).toBe(0);

    expect(await client.head()).not.toBe(first);
    expect(git(cwd, "rev-list", "--count", "HEAD~1..HEAD").trim()).toBe("1");
    expect(readFileSync(marker, "utf-8")).toBe("ran\nran\n");
  });

  it("creates a task branch at the specified base SHA", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();

    await client.createTaskBranch("pipkin/implement/r1/t001-task", baseSha);

    const branches = git(cwd, "branch", "--list");
    expect(branches).toContain("pipkin/implement/r1/t001-task");
  });

  it("adds and removes a worktree", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = join(
      cwd,
      ".pi",
      "pipkin",
      "implement",
      "worktrees",
      "r1",
      "t001-wt-test",
    );
    const branchName = "pipkin/implement/r1/t001-wt-test";

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    const wtList = git(cwd, "worktree", "list", "--porcelain");
    expect(wtList).toContain(worktreePath);

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);

    const wtListAfter = git(cwd, "worktree", "list", "--porcelain");
    expect(wtListAfter).not.toContain(worktreePath);
    const branchesAfter = git(cwd, "branch", "--list");
    expect(branchesAfter).not.toContain(branchName);
  });

  it("forWorktree returns a GitClient rooted at the worktree", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = realpathSync(
      temporaryDirectory("pipkin-implement-wt2-"),
    );
    const branchName = "pipkin/implement/r1/t001-for-wt";

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    const wtClient = client.forWorktree(worktreePath);
    const wtRoot = await wtClient.root();
    expect(wtRoot).toBe(worktreePath);

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);
  });

  it("uses the git admin dir as a per-checkout identity", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = realpathSync(
      temporaryDirectory("pipkin-implement-wt-identity-"),
    );
    const branchName = "pipkin/implement/r1/t001-identity";

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    const mainIdentity = await client.checkoutIdentity();
    const wtIdentity = await client
      .forWorktree(worktreePath)
      .checkoutIdentity();

    expect(mainIdentity).not.toBe(wtIdentity);
    expect(wtIdentity).toContain(join(".git", "worktrees"));

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);
  });

  it("excludes main-checkout plan artifacts when staging in a worktree", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "plan.md"), "# Plan\n");
    git(cwd, "add", "plan.md");
    git(cwd, "commit", "-m", "chore: add plan");
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = realpathSync(
      temporaryDirectory("pipkin-implement-wt5-"),
    );
    const branchName = "pipkin/implement/r1/t001-plan-exclude";

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    const wtClient = client.forWorktree(worktreePath);
    writeFileSync(join(worktreePath, "plan.md"), "# Mutated Plan\n");
    writeFileSync(
      join(worktreePath, "worker.ts"),
      "export const worker = true;\n",
    );
    git(worktreePath, "add", "worker.ts");

    expect(await wtClient.stagedNameStatus()).toBe("A\tworker.ts\n");

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);
  });
});
