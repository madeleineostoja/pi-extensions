import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalRoot,
  SandboxPolicyError,
  resolveSandboxPolicy,
} from "./policy.js";

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
      standardTemporaryRoots: [],
      env: {
        npm_config_cache: join(home, "missing-npm"),
        XDG_CACHE_HOME: join(home, "missing-xdg"),
      },
    });
    expect(policy.workspaceRoot).toBe(realpathSync(root));
    expect(policy.git).toBeUndefined();
    expect(policy.cacheRoots).toEqual([
      join(realpathSync(home), "missing-npm"),
      join(realpathSync(home), "Library", "pnpm", "store"),
      join(realpathSync(home), "Library", "Caches", "pnpm"),
      join(realpathSync(home), "missing-xdg", "gh"),
    ]);
  });

  it("records exact missing ancestors needed to create reviewed cache roots", async () => {
    const root = directory("missing-cache-ancestors");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const temporary = join(root, "temporary");
    mkdirSync(workspace);
    mkdirSync(home);
    mkdirSync(temporary);
    const canonicalHome = realpathSync(home);
    const npmParent = join(canonicalHome, "cache-parent");
    const npm = join(npmParent, "npm");

    expect(canonicalRoot(join(home, "cache-parent", "npm"))).toEqual({
      path: npm,
      creationRoots: [npmParent, npm],
    });
    expect(canonicalRoot(`${home}/missing/../normalized-cache`)).toEqual({
      path: join(canonicalHome, "normalized-cache"),
      creationRoots: [join(canonicalHome, "normalized-cache")],
    });

    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: { npm_config_cache: join(home, "cache-parent", "npm") },
    });
    expect(policy.writableRoots).toContain(npm);
    expect(policy.creationRoots).toEqual([
      npmParent,
      join(canonicalHome, "Library"),
      join(canonicalHome, "Library", "pnpm"),
      join(canonicalHome, "Library", "Caches"),
      join(canonicalHome, ".cache"),
      join(canonicalHome, ".local"),
      join(canonicalHome, ".local", "state"),
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
      standardTemporaryRoots: [],
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
    const temporary = directory("linked-temporary");
    const home = directory("linked-home");
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
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {},
    });
    expect(policy.workspaceRoot).toBe(realpathSync(linked));
    expect(policy.git?.worktreeGitDir).not.toBe(policy.git?.commonGitDir);
    expect(policy.git?.commonGitDir).toBe(realpathSync(join(root, ".git")));
    expect(policy.writableRoots).toEqual(
      expect.arrayContaining([
        realpathSync(linked),
        policy.git!.commonGitDir,
        realpathSync(temporary),
      ]),
    );
    expect(policy.writableRoots).not.toContain(policy.git!.worktreeGitDir);
    expect(policy.writableRoots).not.toContain(realpathSync(root));
  });

  it("grants dependency installations from a containing package workspace", async () => {
    const root = directory("nested-worktree");
    const linked = join(root, ".pi", "worktrees", "linked");
    const temporary = directory("nested-temporary");
    const home = directory("nested-home");
    const rootModules = join(root, "node_modules");
    const packageRoot = join(root, "packages", "feature");
    const packageModules = join(packageRoot, "node_modules");
    const escapedPackageRoot = join(root, "packages", "escaped");
    const escapedModules = join(escapedPackageRoot, "node_modules");
    const escapedTarget = directory("escaped-modules");
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    writeFileSync(join(root, "package.json"), '{"private":true}\n');
    writeFileSync(join(root, ".gitignore"), ".pi/\nnode_modules/\n");
    mkdirSync(rootModules);
    mkdirSync(packageModules, { recursive: true });
    mkdirSync(escapedPackageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), '{"private":true}\n');
    writeFileSync(
      join(escapedPackageRoot, "package.json"),
      '{"private":true}\n',
    );
    symlinkSync(escapedTarget, escapedModules);
    git(root, ["add", "package.json", ".gitignore", "packages"]);
    git(root, ["commit", "-m", "initial"]);
    git(root, ["worktree", "add", "-b", "linked", linked]);

    const policy = await resolveSandboxPolicy({
      sessionCwd: linked,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {},
    });

    expect(policy.workspaceRoot).toBe(realpathSync(linked));
    expect(policy.writableRoots).toEqual(
      expect.arrayContaining([
        realpathSync(rootModules),
        realpathSync(packageModules),
      ]),
    );
    expect(policy.writableRoots).not.toContain(realpathSync(root));
    expect(policy.writableRoots).not.toContain(realpathSync(escapedTarget));
  });

  it("normalizes the configured and standard temporary roots", async () => {
    const workspace = directory("temporary-workspace");
    const temporary = directory("temporary-root");
    const standardTemporary = directory("standard-temporary-root");
    const alias = join(dirname(temporary), `${basename(temporary)}-alias`);
    directories.push(alias);
    symlinkSync(temporary, alias);
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: directory("temporary-home"),
      temporaryDir: alias,
      standardTemporaryRoots: [standardTemporary],
      env: { TMPDIR: alias },
    });
    const canonicalTemporary = realpathSync(temporary);
    expect(policy.temporaryRoots).toEqual([
      canonicalTemporary,
      realpathSync(standardTemporary),
    ]);
    expect(
      policy.temporaryRoots.filter((root) => root === canonicalTemporary),
    ).toHaveLength(1);
  });

  it("grants only reviewed tool cache and state purposes and their final effective roots", async () => {
    const root = directory("reviewed-caches");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const temporary = join(root, "temporary");
    const npm = join(root, "npm");
    const xdgCache = join(root, "xdg-cache");
    const ghCache = join(xdgCache, "gh");
    const xdgState = join(root, "xdg-state");
    const ghState = join(xdgState, "gh");
    const pnpmStore = join(home, "Library", "pnpm", "store");
    const pnpmCache = join(home, "Library", "Caches", "pnpm");
    for (const path of [
      workspace,
      home,
      temporary,
      npm,
      ghCache,
      ghState,
      pnpmStore,
      pnpmCache,
    ]) {
      mkdirSync(path, { recursive: true });
    }
    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {
        npm_config_cache: npm,
        XDG_CACHE_HOME: xdgCache,
        XDG_STATE_HOME: xdgState,
        PNPM_HOME: join(home, "pnpm-bin"),
      },
    });
    const canonicalRoots = [npm, pnpmStore, pnpmCache, ghCache].map((path) =>
      realpathSync(path),
    );
    expect(policy.cacheRoots).toEqual(canonicalRoots);
    expect(policy.writableRoots).toEqual(
      expect.arrayContaining([
        realpathSync(workspace),
        realpathSync(temporary),
        realpathSync(ghState),
        ...canonicalRoots,
      ]),
    );
    expect(policy.writableRoots).not.toContain(realpathSync(home));
    expect(policy.writableRoots).not.toContain(realpathSync(xdgCache));
    expect(policy.writableRoots).not.toContain(
      realpathSync(join(home, "Library", "pnpm")),
    );
    expect(policy.writableRoots).not.toContain(
      realpathSync(join(home, "Library", "Caches")),
    );
    expect(policy.writableRoots).not.toContain(
      join(realpathSync(home), ".cargo"),
    );
    expect(policy.writableRoots).not.toContain(
      join(realpathSync(home), "pnpm-bin"),
    );
    expect(policy.writableRoots).not.toContain(
      join(realpathSync(home), ".config", "gh"),
    );
    expect(policy.writableRoots).not.toContain(
      join(realpathSync(home), ".local", "share", "gh"),
    );
  });

  it("grants gh default cache and state without its config or data directories", async () => {
    const root = directory("gh-roots");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const temporary = join(root, "temporary");
    mkdirSync(workspace);
    mkdirSync(home);
    mkdirSync(temporary);
    const canonicalHome = realpathSync(home);
    const ghCache = join(canonicalHome, ".cache", "gh");
    const ghState = join(canonicalHome, ".local", "state", "gh");

    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: temporary,
      standardTemporaryRoots: [],
      env: {},
    });

    expect(policy.cacheRoots).toContain(ghCache);
    expect(policy.writableRoots).toEqual(
      expect.arrayContaining([ghCache, ghState]),
    );
    expect(policy.writableRoots).not.toContain(
      join(canonicalHome, ".config", "gh"),
    );
    expect(policy.writableRoots).not.toContain(
      join(canonicalHome, ".local", "share", "gh"),
    );
  });

  it("omits gh roots that overlap its protected config or data", async () => {
    const root = directory("gh-overlap");
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const config = join(home, ".config", "gh");
    const data = join(home, ".local", "share", "gh");
    const cacheAlias = join(root, "cache-alias");
    mkdirSync(workspace);
    mkdirSync(config, { recursive: true });
    mkdirSync(data, { recursive: true });
    symlinkSync(dirname(config), cacheAlias);

    const policy = await resolveSandboxPolicy({
      sessionCwd: workspace,
      homeDir: home,
      temporaryDir: workspace,
      standardTemporaryRoots: [],
      env: {
        GH_CONFIG_DIR: "",
        XDG_CACHE_HOME: cacheAlias,
        XDG_STATE_HOME: join(home, ".local", "share"),
      },
    });

    expect(policy.writableRoots).not.toContain(realpathSync(config));
    expect(policy.writableRoots).not.toContain(realpathSync(data));
  });

  it("canonicalizes aliases and collapses covered roots", async () => {
    const root = directory("aliases");
    const alias = join(dirname(root), `${basename(root)}-alias`);
    symlinkSync(root, alias);
    const policy = await resolveSandboxPolicy({
      sessionCwd: alias,
      temporaryDir: root,
      standardTemporaryRoots: [],
      env: { npm_config_cache: join(root, "cache") },
    });
    expect(policy.sessionCwd).toBe(realpathSync(root));
    expect(policy.writableRoots).toContain(realpathSync(root));
    expect(policy.writableRoots).not.toContain(
      join(realpathSync(root), "cache"),
    );
  });

  it("omits dangling and looping cache symlinks without creating absent roots", async () => {
    const root = directory("cache-links");
    const home = join(root, "home");
    const dangling = join(home, "dangling");
    const parent = join(home, "parent");
    const pnpmStore = join(home, "Library", "pnpm", "store");
    const pnpmCache = join(home, "Library", "Caches", "pnpm");
    mkdirSync(home);
    mkdirSync(dirname(pnpmStore), { recursive: true });
    mkdirSync(dirname(pnpmCache), { recursive: true });
    symlinkSync(join(root, "missing"), dangling);
    symlinkSync(join(root, "missing-parent"), parent);
    symlinkSync(join(root, "missing-store"), pnpmStore);
    symlinkSync("pnpm", pnpmCache);
    const policy = await resolveSandboxPolicy({
      sessionCwd: root,
      homeDir: home,
      temporaryDir: root,
      standardTemporaryRoots: [],
      env: {
        npm_config_cache: dangling,
        XDG_CACHE_HOME: join(parent, "cache"),
      },
    });
    expect(policy.cacheRoots).not.toContain(dangling);
    expect(policy.cacheRoots).not.toContain(join(parent, "cache"));
    expect(policy.cacheRoots).not.toContain(pnpmStore);
    expect(policy.cacheRoots).not.toContain(pnpmCache);
    expect(policy.cacheRoots).toEqual([]);
    expect(existsSync(join(home, ".npm"))).toBe(false);
  });

  it("does not turn a genuine Git error into a non-Git policy", async () => {
    const root = directory("git-error");
    await expect(
      resolveSandboxPolicy({
        sessionCwd: root,
        standardTemporaryRoots: [],
        gitRunner: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "broken Git",
        }),
      }),
    ).rejects.toBeInstanceOf(SandboxPolicyError);
  });
});
