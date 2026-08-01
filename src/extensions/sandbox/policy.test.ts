import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxPolicyError, resolveSandboxPolicy } from "./policy.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

function directory(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `pipkin-sandbox-${name}-`));
  directories.push(root);
  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("Sandbox policy", () => {
  it("uses a non-Git cwd as the workspace and retains absent reviewed cache roots", async () => {
    const root = directory("plain");
    const home = join(root, "home");
    mkdirSync(home);
    const policy = await resolveSandboxPolicy({
      sessionCwd: root,
      homeDir: home,
      temporaryDir: root,
      env: {
        npm_config_cache: join(home, "missing-npm"),
        XDG_CACHE_HOME: join(home, "missing-xdg"),
      },
    });
    expect(policy.workspaceRoot).toBe(realpathSync(root));
    expect(policy.git).toBeUndefined();
    expect(policy.cacheRoots).toEqual([
      join(realpathSync(home), "missing-npm"),
      join(realpathSync(home), "missing-xdg"),
      join(realpathSync(home), "Library", "pnpm", "store"),
      join(realpathSync(home), "Library", "Caches", "pnpm"),
    ]);
  });

  it("resolves a repository subdirectory and its Git administration", async () => {
    const root = directory("repository");
    git(root, ["init"]);
    const child = join(root, "child");
    mkdirSync(child);
    const policy = await resolveSandboxPolicy({
      sessionCwd: child,
      temporaryDir: root,
      env: {},
    });
    expect(policy.workspaceRoot).toBe(realpathSync(root));
    expect(policy.git).toEqual({
      worktreeRoot: realpathSync(root),
      worktreeGitDir: realpathSync(join(root, ".git")),
      commonGitDir: realpathSync(join(root, ".git")),
    });
  });

  it("resolves linked worktree administration without granting the primary checkout", async () => {
    const root = directory("worktree");
    const linked = join(dirname(root), `${basename(root)}-linked`);
    directories.push(linked);
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], {
      cwd: root,
      stdio: "pipe",
    });
    git(root, ["worktree", "add", "-b", "linked", linked]);
    const policy = await resolveSandboxPolicy({
      sessionCwd: linked,
      temporaryDir: root,
      env: {},
    });
    expect(policy.workspaceRoot).toBe(realpathSync(linked));
    expect(policy.git?.worktreeGitDir).not.toBe(policy.git?.commonGitDir);
    expect(policy.git?.commonGitDir).toBe(realpathSync(join(root, ".git")));
  });

  it("canonicalizes aliases and collapses covered roots", async () => {
    const root = directory("aliases");
    const alias = join(dirname(root), `${basename(root)}-alias`);
    symlinkSync(root, alias);
    const policy = await resolveSandboxPolicy({
      sessionCwd: alias,
      temporaryDir: root,
      env: { npm_config_cache: join(root, "cache") },
    });
    expect(policy.sessionCwd).toBe(realpathSync(root));
    expect(policy.writableRoots).toContain(realpathSync(root));
    expect(policy.writableRoots).not.toContain(
      join(realpathSync(root), "cache"),
    );
  });

  it("does not turn a genuine Git error into a non-Git policy", async () => {
    const root = directory("git-error");
    await expect(
      resolveSandboxPolicy({
        sessionCwd: root,
        gitRunner: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "broken Git",
        }),
      }),
    ).rejects.toBeInstanceOf(SandboxPolicyError);
  });
});
