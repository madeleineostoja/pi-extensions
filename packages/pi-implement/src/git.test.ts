import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecGitClient, isCleanStatus } from "./git.js";
import { GitProcess } from "./git-process.js";
import {
  observePromise,
  remainsTrue,
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
  const cwd = temporaryDirectory("pi-implement-git-");
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
    const dir = temporaryDirectory("pi-implement-git-hold-");
    const marker = join(dir, "marker");
    const release = join(dir, "release");
    const script = join(dir, "hold.mjs");
    writeFileSync(
      script,
      `import { appendFileSync, existsSync } from "node:fs";\nimport { setTimeout } from "node:timers/promises";\nconst [marker, release, id] = process.argv.slice(2);\nappendFileSync(marker, id + "\\n");\nwhile (!existsSync(release)) await setTimeout(5);\n`,
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
      const secondObservation = observePromise("second command", second);
      await remainsTrue(
        "the second command queue boundary",
        () => readFileSync(marker, "utf-8") === "first\n",
        {
          diagnostics: () =>
            `${firstObservation.describe()}; ${secondObservation.describe()}`,
        },
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
    const linked = join(temporaryDirectory("pi-implement-linked-"), "linked");
    git(cwd, "worktree", "add", "-b", "linked", linked);
    const dir = temporaryDirectory("pi-implement-git-hold-");
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
    const linked = join(temporaryDirectory("pi-implement-linked-"), "linked");
    git(cwd, "worktree", "add", "-b", "linked", linked);
    const dir = temporaryDirectory("pi-implement-git-hold-");
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
      const secondObservation = observePromise("linked command", second);
      await remainsTrue(
        "the common repository queue boundary",
        () => readFileSync(marker, "utf-8") === "main\n",
        {
          diagnostics: () =>
            `${firstObservation.describe()}; ${secondObservation.describe()}`,
        },
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
    const dir = temporaryDirectory("pi-implement-git-cancel-");
    const marker = join(dir, "marker");
    const pidPath = join(dir, "pid");
    const release = join(dir, "release");
    const script = join(dir, "hold.mjs");
    writeFileSync(
      script,
      `import { appendFileSync, existsSync, writeFileSync } from "node:fs";\nimport { setTimeout } from "node:timers/promises";\nconst [marker, pidPath, release] = process.argv.slice(2);\nwriteFileSync(pidPath, String(process.pid));\nappendFileSync(marker, "started\\n");\nwhile (!existsSync(release)) await setTimeout(5);\n`,
    );
    const controller = new AbortController();
    const process = new GitProcess(cwd);
    const command = process.run(
      ["-c", holdAlias(script), "hold", marker, pidPath, release],
      { cwd, signal: controller.signal },
    );
    const observation = observePromise("cancelled command", command);
    let childPid: number | undefined;
    try {
      await waitForCondition(
        "owned Git child startup",
        () => existsSync(pidPath),
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
        "owned Git child termination",
        () => !processIsAlive(startedChildPid),
        { diagnostics: observation.describe },
      );
    } finally {
      writeFileSync(release, "go");
      controller.abort();
      if (childPid && processIsAlive(childPid)) {
        globalThis.process.kill(childPid, "SIGKILL");
      }
      const cleanupChildPid = childPid;
      await settleAll([
        settle("cancelled command", command, {
          diagnostics: observation.describe,
        }),
        settle("cancelled Git queue", process.onIdle(), {
          diagnostics: observation.describe,
        }),
        ...(cleanupChildPid
          ? [
              waitForCondition(
                "owned Git child termination during cleanup",
                () => !processIsAlive(cleanupChildPid),
                { diagnostics: observation.describe },
              ),
            ]
          : []),
      ]);
    }
  });

  it("reports a prematurely exiting Git child without waiting for the suite timeout", async () => {
    const cwd = repo();
    const dir = temporaryDirectory("pi-implement-git-exit-");
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
    setTimeout(() => rmSync(lock), 10);

    await expect(new ExecGitClient(cwd).tree()).resolves.toMatch(
      /^[0-9a-f]{40}$/,
    );
  });

  it("keeps Git subprocesses inside the execution boundary", () => {
    const sourceDir = new URL(".", import.meta.url);
    for (const name of ["git.ts", "candidate.ts", "candidate-worker.ts"]) {
      const source = readFileSync(new URL(name, sourceDir), "utf-8");
      expect(source).not.toContain("node:child_process");
      expect(source).not.toMatch(/exec(?:File)?\s*\(\s*["']git/);
    }
    expect(readdirSync(new URL(".", import.meta.url))).toContain(
      "git-process.ts",
    );
  });

  it("parses clean status", () => {
    expect(isCleanStatus("")).toBe(true);
    expect(isCleanStatus(" M file.ts\n")).toBe(false);
  });

  it("stages untracked files for review", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "new.ts"), "export const added = true;\n");
    const client = new ExecGitClient(cwd);

    await client.stageAllExcept([]);

    expect(await client.stagedNameStatus()).toContain("A\tnew.ts");
    expect(await client.stagedDiff()).toContain("export const added = true;");
  });

  it("detects rebase directory state as an active operation", async () => {
    const cwd = repo();
    mkdirSync(join(cwd, ".git", "rebase-merge"));
    const client = new ExecGitClient(cwd);

    expect(await client.activeOperation()).toBe("rebase");
  });

  it("stages repo-relative paths from a nested client cwd", async () => {
    const cwd = repo();
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "nested.ts"),
      "export const nested = true;\n",
    );
    const client = new ExecGitClient(join(cwd, "src"));

    await client.stagePaths(["src/nested.ts"]);

    expect(await client.stagedNameStatus()).toBe("A\tsrc/nested.ts\n");
  });

  it("excludes plan artifacts without force-adding ignored files", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, ".gitignore"), "plan.md\nignored.log\n");
    git(cwd, "add", ".gitignore");
    git(cwd, "commit", "-m", "chore: ignore files");
    writeFileSync(join(cwd, "plan.md"), "# Plan\n");
    writeFileSync(join(cwd, "ignored.log"), "ignored\n");
    writeFileSync(join(cwd, "new.ts"), "export const added = true;\n");
    const client = new ExecGitClient(cwd);

    await client.stageAllExcept([join(cwd, "plan.md")]);

    expect(await client.stagedNameStatus()).toBe("A\tnew.ts\n");
  });

  it("treats worktree as clean except known plan artifacts", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "plan.md"), "# Plan\n");
    writeFileSync(join(cwd, "tracked.ts"), "export const value = 2;\n");
    const client = new ExecGitClient(cwd);

    expect(await client.isCleanExcept([join(cwd, "plan.md")])).toBe(false);
    git(cwd, "checkout", "--", "tracked.ts");
    expect(await client.isCleanExcept([join(cwd, "plan.md")])).toBe(true);
  });

  it("normalizes accidental forced ignored staging", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, ".gitignore"), "ignored.log\n");
    git(cwd, "add", ".gitignore");
    git(cwd, "commit", "-m", "chore: ignore logs");
    writeFileSync(join(cwd, "ignored.log"), "ignored\n");
    writeFileSync(join(cwd, "new.ts"), "export const added = true;\n");
    git(cwd, "add", "-f", "ignored.log");
    const client = new ExecGitClient(cwd);

    await client.stageAllExcept([]);

    expect(await client.stagedNameStatus()).toBe("A\tnew.ts\n");
  });

  it("restores reviewer worktree edits from the staged index", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "tracked.ts"), "export const value = 2;\n");
    const client = new ExecGitClient(cwd);
    await client.stageAllExcept([]);
    const before = await client.worktreeFingerprintExcept([]);
    writeFileSync(join(cwd, "tracked.ts"), "export const value = 3;\n");
    writeFileSync(join(cwd, "reviewer.tmp"), "oops\n");

    await client.restoreWorktreeFromIndexExcept([]);

    expect(await client.worktreeFingerprintExcept([])).toBe(before);
    expect(git(cwd, "status", "--porcelain")).toBe("M  tracked.ts\n");
  });

  it("creates and amends hook-free recovery checkpoints", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    writeFileSync(join(cwd, "tracked.ts"), "export const value = 2;\n");
    await client.stageAllExcept([]);
    expect(
      (await client.checkpoint("pi-implement: candidate", false)).exitCode,
    ).toBe(0);
    const first = await client.head();

    writeFileSync(join(cwd, "next.ts"), "export const next = true;\n");
    await client.stageAllExcept([]);
    expect(
      (await client.checkpoint("pi-implement: candidate", true)).exitCode,
    ).toBe(0);

    expect(await client.head()).not.toBe(first);
    expect(git(cwd, "rev-list", "--count", "HEAD~1..HEAD").trim()).toBe("1");
  });

  it("restores the staged candidate patch after index mutation", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "tracked.ts"), "export const value = 2;\n");
    const client = new ExecGitClient(cwd);
    await client.stageAllExcept([]);
    const patch = await client.stagedDiff();
    const before = await client.stagedFingerprint();
    git(cwd, "reset", "--hard", "HEAD");

    await client.restoreStagedPatch(patch, []);

    expect(await client.stagedFingerprint()).toBe(before);
    expect(git(cwd, "status", "--porcelain")).toBe("M  tracked.ts\n");
  });

  it("creates a task branch at the specified base SHA", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();

    await client.createTaskBranch("pi-implement/r1/t001-task", baseSha);

    const branches = git(cwd, "branch", "--list");
    expect(branches).toContain("pi-implement/r1/t001-task");
  });

  it("adds and removes a worktree", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = join(
      cwd,
      ".pi",
      "implement",
      "worktrees",
      "r1",
      "t001-wt-test",
    );
    const branchName = "pi-implement/r1/t001-wt-test";

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

  it("idempotently registers an info/exclude pattern and hides in-repo worktrees from status", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = join(
      cwd,
      ".pi",
      "implement",
      "worktrees",
      "r1",
      "t001-wt-test",
    );
    const branchName = "pi-implement/r1/t001-wt-test";

    await client.ensureInfoExclude("/.pi/implement/");
    const excludeContent = readFileSync(
      join(cwd, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(excludeContent).toContain("/.pi/implement/");

    // Second call must not duplicate the line
    await client.ensureInfoExclude("/.pi/implement/");
    const excludeContentAfter = readFileSync(
      join(cwd, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(
      excludeContentAfter.split("\n").filter((l) => l === "/.pi/implement/"),
    ).toHaveLength(1);

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    expect(await client.isClean()).toBe(true);

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);
  });

  it("forWorktree returns a GitClient rooted at the worktree", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = realpathSync(temporaryDirectory("pi-implement-wt2-"));
    const branchName = "pi-implement/r1/t001-for-wt";

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
      temporaryDirectory("pi-implement-wt-identity-"),
    );
    const branchName = "pi-implement/r1/t001-identity";

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

  it("stages and commits in a worktree without changing main HEAD", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = realpathSync(temporaryDirectory("pi-implement-wt3-"));
    const branchName = "pi-implement/r1/t001-commit-test";

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    const wtClient = client.forWorktree(worktreePath);
    writeFileSync(join(worktreePath, "new.ts"), "export const added = true;\n");
    await wtClient.stageAllExcept([]);
    expect(await wtClient.hasStagedChanges()).toBe(true);
    const commitResult = await wtClient.commit("feat: add new.ts");
    expect(commitResult.exitCode).toBe(0);

    // Main HEAD should be unchanged
    expect(await client.head()).toBe(baseSha);
    // Worktree HEAD should have advanced
    expect(await wtClient.head()).not.toBe(baseSha);

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);
  });

  it("reads staged diff, diff stat, and name-status from a worktree", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();
    const worktreePath = realpathSync(temporaryDirectory("pi-implement-wt4-"));
    const branchName = "pi-implement/r1/t001-diff-test";

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    const wtClient = client.forWorktree(worktreePath);
    writeFileSync(join(worktreePath, "diff.ts"), "export const x = 42;\n");
    await wtClient.stageAllExcept([]);

    expect(await wtClient.stagedDiff()).toContain("diff.ts");
    expect(await wtClient.stagedDiffStat()).toContain("diff.ts");
    expect(await wtClient.stagedNameStatus()).toContain("diff.ts");

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
    const worktreePath = realpathSync(temporaryDirectory("pi-implement-wt5-"));
    const branchName = "pi-implement/r1/t001-plan-exclude";

    await client.createTaskBranch(branchName, baseSha);
    await client.addWorktree(worktreePath, branchName);

    const wtClient = client.forWorktree(worktreePath);
    writeFileSync(join(worktreePath, "plan.md"), "# Mutated Plan\n");
    writeFileSync(
      join(worktreePath, "worker.ts"),
      "export const worker = true;\n",
    );
    await wtClient.stageAllExcept([join(cwd, "plan.md")]);

    expect(await wtClient.stagedNameStatus()).toBe("A\tworker.ts\n");

    await client.removeWorktree(worktreePath);
    await client.deleteTaskBranch(branchName);
  });

  it("returns and applies the complete diff between two commits", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);
    const baseSha = await client.head();

    writeFileSync(join(cwd, "tracked.ts"), "export const value = 2;\n");
    writeFileSync(join(cwd, "feature.ts"), "export const feat = true;\n");
    git(cwd, "add", "tracked.ts", "feature.ts");
    git(cwd, "commit", "-m", "feat: add feature");

    const headSha = await client.head();
    const diff = await client.diffRange(baseSha, headSha);
    git(cwd, "reset", "--hard", baseSha);

    const result = await client.applyPatch(diff);

    expect(result.exitCode).toBe(0);
    expect(await client.stagedNameStatus()).toBe(
      "A\tfeature.ts\nM\ttracked.ts\n",
    );
    expect(readFileSync(join(cwd, "feature.ts"), "utf-8")).toBe(
      "export const feat = true;\n",
    );
    expect(readFileSync(join(cwd, "tracked.ts"), "utf-8")).toBe(
      "export const value = 2;\n",
    );
  });

  it("rewords the current commit message without changing parent", async () => {
    const cwd = repo();
    const client = new ExecGitClient(cwd);

    writeFileSync(join(cwd, "feature.ts"), "export const feat = true;\n");
    git(cwd, "add", "feature.ts");
    git(cwd, "commit", "-m", "feat: add feature");

    const parentSha = git(cwd, "rev-parse", "HEAD^").trim();
    const beforeHead = await client.head();

    const result = await client.reword("feat: add feature (reworded)");
    expect(result.exitCode).toBe(0);

    const afterHead = await client.head();
    expect(afterHead).not.toBe(beforeHead);

    const message = git(cwd, "log", "-1", "--format=%B").trim();
    expect(message).toBe("feat: add feature (reworded)");

    const afterParentSha = git(cwd, "rev-parse", "HEAD^").trim();
    expect(afterParentSha).toBe(parentSha);
  });
});
