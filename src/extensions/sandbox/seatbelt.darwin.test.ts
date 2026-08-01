import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxPolicy } from "./policy.js";
import { SANDBOX_EXECUTABLE, sandboxArguments } from "./seatbelt.js";

const directories: string[] = [];
const skipSeatbelt =
  process.platform !== "darwin" || process.env.PI_CODING_AGENT === "true";

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

function directory(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `pipkin-seatbelt-${name}-`));
  directories.push(path);
  return realpathSync(path);
}

function policy(
  workspaceRoot: string,
  writableRoots: readonly string[] = [workspaceRoot],
): SandboxPolicy {
  return {
    sessionCwd: workspaceRoot,
    workspaceRoot,
    temporaryRoots: [],
    cacheRoots: [],
    writableRoots,
  };
}

function run(
  sandboxPolicy: SandboxPolicy,
  cwd: string,
  command: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(
    SANDBOX_EXECUTABLE,
    sandboxArguments({
      policy: sandboxPolicy,
      shell: { shell: "/bin/sh", args: ["-s"] },
    }),
    { cwd, encoding: "utf8", input: command },
  );
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "pipe" });
}

describe("Sandbox Seatbelt integration", () => {
  it.skipIf(skipSeatbelt)(
    "allows broad reads plus workspace and reviewed disposable-root writes while denying outside and symlink writes",
    () => {
      const parent = directory("boundary");
      const workspace = join(parent, "workspace");
      const cache = join(parent, "cache");
      const outside = join(parent, "outside.txt");
      mkdirSync(workspace);
      mkdirSync(cache);
      writeFileSync(outside, "before");
      const canonicalWorkspace = realpathSync(workspace);
      const sandboxPolicy = policy(canonicalWorkspace, [
        canonicalWorkspace,
        realpathSync(cache),
      ]);

      const read = run(
        sandboxPolicy,
        canonicalWorkspace,
        `cat ${JSON.stringify(outside)}`,
      );
      expect(read.status).toBe(0);
      expect(read.stdout).toBe("before");

      const writes = run(
        sandboxPolicy,
        canonicalWorkspace,
        "mkdir -p nested\nprintf workspace > nested/file.txt\nprintf cache > " +
          JSON.stringify(join(cache, "entry.txt")),
      );
      expect(writes.status).toBe(0);
      expect(
        readFileSync(join(canonicalWorkspace, "nested", "file.txt"), "utf8"),
      ).toBe("workspace");
      expect(readFileSync(join(cache, "entry.txt"), "utf8")).toBe("cache");

      const outsideWrite = run(
        sandboxPolicy,
        canonicalWorkspace,
        `printf changed > ${JSON.stringify(outside)}`,
      );
      expect(outsideWrite.status).not.toBe(0);
      expect(readFileSync(outside, "utf8")).toBe("before");

      symlinkSync(outside, join(canonicalWorkspace, "outside-link"));
      const symlinkWrite = run(
        sandboxPolicy,
        canonicalWorkspace,
        "printf changed > outside-link",
      );
      expect(symlinkWrite.status).not.toBe(0);
      expect(readFileSync(outside, "utf8")).toBe("before");
    },
  );

  it.skipIf(skipSeatbelt)(
    "propagates the production profile to descendant processes",
    () => {
      const parent = directory("descendant");
      const workspace = join(parent, "workspace");
      const outside = join(parent, "outside.txt");
      mkdirSync(workspace);
      writeFileSync(outside, "before");
      const canonicalWorkspace = realpathSync(workspace);
      const childWrite = `require("node:fs").writeFileSync(${JSON.stringify(outside)}, "changed")`;
      const result = run(
        policy(canonicalWorkspace),
        canonicalWorkspace,
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childWrite)}`,
      );
      expect(result.status).not.toBe(0);
      expect(readFileSync(outside, "utf8")).toBe("before");
    },
  );

  it.skipIf(skipSeatbelt)(
    "permits ordinary Git mutations through an ordinary checkout administration directory",
    () => {
      const workspace = directory("ordinary-git");
      git(workspace, ["init"]);
      git(workspace, ["config", "user.email", "sandbox@example.test"]);
      git(workspace, ["config", "user.name", "Sandbox"]);
      const result = run(
        policy(workspace),
        workspace,
        "printf tracked > tracked.txt\ngit add tracked.txt\ngit commit -m sandbox-commit\ngit branch sandbox-branch",
      );
      expect(result.status).toBe(0);
      expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe(
        "tracked",
      );
      expect(
        execFileSync("git", ["log", "-1", "--format=%s"], {
          cwd: workspace,
          encoding: "utf8",
        }).trim(),
      ).toBe("sandbox-commit");
      expect(
        execFileSync("git", ["branch", "--list", "sandbox-branch"], {
          cwd: workspace,
          encoding: "utf8",
        }).trim(),
      ).toBe("sandbox-branch");
    },
  );

  it.skipIf(skipSeatbelt)(
    "permits linked-worktree Git state but not primary or sibling checkout content",
    () => {
      const parent = directory("linked-git");
      const primary = join(parent, "primary");
      const linked = join(parent, "linked");
      const sibling = join(parent, "sibling");
      mkdirSync(primary);
      git(primary, ["init"]);
      git(primary, ["config", "user.email", "sandbox@example.test"]);
      git(primary, ["config", "user.name", "Sandbox"]);
      writeFileSync(join(primary, "primary.txt"), "committed");
      git(primary, ["add", "primary.txt"]);
      git(primary, ["commit", "-m", "initial"]);
      git(primary, ["worktree", "add", "-b", "linked", linked]);
      git(primary, ["worktree", "add", "-b", "sibling", sibling]);
      writeFileSync(join(primary, "primary.txt"), "changed");
      const canonicalLinked = realpathSync(linked);
      const worktreeGitDir = realpathSync(
        execFileSync("git", ["rev-parse", "--git-dir"], {
          cwd: linked,
          encoding: "utf8",
        }).trim(),
      );
      const commonGitDir = realpathSync(
        execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd: linked,
          encoding: "utf8",
        }).trim(),
      );
      const sandboxPolicy = policy(canonicalLinked, [
        canonicalLinked,
        worktreeGitDir,
        commonGitDir,
      ]);

      const commit = run(
        sandboxPolicy,
        canonicalLinked,
        "printf linked > linked.txt\ngit add linked.txt\ngit commit -m linked-commit\ngit branch linked-branch",
      );
      expect(commit.status).toBe(0);
      expect(
        execFileSync("git", ["log", "-1", "--format=%s"], {
          cwd: linked,
          encoding: "utf8",
        }).trim(),
      ).toBe("linked-commit");
      expect(
        execFileSync("git", ["branch", "--list", "linked-branch"], {
          cwd: linked,
          encoding: "utf8",
        }).trim(),
      ).toBe("linked-branch");

      const siblingWrite = run(
        sandboxPolicy,
        canonicalLinked,
        `printf changed > ${JSON.stringify(join(sibling, "sibling.txt"))}`,
      );
      expect(siblingWrite.status).not.toBe(0);
      expect(readFileSync(join(primary, "primary.txt"), "utf8")).toBe(
        "changed",
      );

      const alternateWorktree = run(
        sandboxPolicy,
        canonicalLinked,
        `git --work-tree=${JSON.stringify(primary)} checkout -f HEAD -- primary.txt`,
      );
      expect(alternateWorktree.status).not.toBe(0);
      expect(readFileSync(join(primary, "primary.txt"), "utf8")).toBe(
        "changed",
      );
    },
  );
});
