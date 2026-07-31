import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeTarget,
  createFixedCapabilities,
  resolvePiToolPath,
  grantMatches,
  isSensitiveHomeTarget,
  type FilesystemGrant,
} from "./capabilities.js";
import { isProtectedReadTarget } from "./protected.js";
import { createGuardRuntimeState } from "./state.js";
import { buildNonoManifest, writeNonoManifest } from "./runtime/manifest.js";

const directories: string[] = [];
afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pipkin-guard-test-"));
  directories.push(root);
  return root;
}

function grant(
  path: string,
  access: "read" | "write",
  kind: "file" | "directory",
): FilesystemGrant {
  return { path, access, kind };
}

describe("Guard capabilities", () => {
  it("matches canonical exact files and directory subtrees without parent promotion", () => {
    const root = fixture();
    const directory = join(root, "shared");
    mkdirSync(directory);
    const file = join(directory, "one");
    writeFileSync(file, "one");
    const alias = join(root, "alias");
    symlinkSync(directory, alias);

    const fileGrant = grant(file, "read", "file");
    const directoryGrant = grant(directory, "write", "directory");
    expect(grantMatches(fileGrant, join(directory, "two"), "read")).toBe(false);
    expect(grantMatches(fileGrant, file, "write")).toBe(false);
    expect(grantMatches(directoryGrant, join(directory, "two"), "write")).toBe(
      true,
    );
    expect(canonicalizeTarget(join(alias, "one"), root)).toBe(
      canonicalizeTarget(file, root),
    );
  });

  it("matches Pi path resolution and read fallback", () => {
    const root = fixture();
    const screenshotDirectory = join(root, "Screenshot 1\u202fAM.png");
    const screenshot = join(screenshotDirectory, "Screenshot 2\u202fPM.png");
    mkdirSync(screenshotDirectory);
    writeFileSync(screenshot, "image");

    expect(
      resolvePiToolPath("~\\.ssh\\id_rsa", "C:\\workspace", {
        platform: "win32",
        homeDir: "C:\\Users\\pipkin",
      }),
    ).toBe("C:\\Users\\pipkin\\.ssh\\id_rsa");
    expect(
      isProtectedReadTarget(
        "C:\\Users\\pipkin\\.ssh\\id_rsa",
        "C:\\Users\\pipkin\\.ssh\\id_rsa",
        "C:\\workspace",
        { platform: "win32", homeDir: "C:\\Users\\pipkin" },
      ),
    ).toBe(true);
    expect(
      canonicalizeTarget(
        join(root, "Screenshot 1 AM.png", "Screenshot 2 PM.png"),
        root,
        true,
      ),
    ).toBe(realpathSync(screenshot));
  });

  it("retains every missing path component below root and an existing ancestor", () => {
    const root = fixture();
    const nested = join(root, "existing");
    mkdirSync(nested);

    expect(canonicalizeTarget("/definitely-pipkin-missing/foo", "/")).toBe(
      "/definitely-pipkin-missing/foo",
    );
    expect(canonicalizeTarget("one/two", nested)).toBe(
      join(canonicalizeTarget(nested, root), "one", "two"),
    );
  });

  it("resets both user toggles for each session", () => {
    const state = createGuardRuntimeState();
    state.setBoundaryEnabled(false);
    state.setSemanticConfirmationEnabled(false);

    state.resetSession();

    expect(state.boundaryEnabled()).toBe(true);
    expect(state.semanticConfirmationEnabled()).toBe(true);
  });

  it("retains ordinary temporary access without promoting a fixture root", () => {
    const root = fixture();
    const workspace = join(root, "workspace");
    const sibling = join(root, "sibling");
    mkdirSync(workspace);
    mkdirSync(sibling);

    const fixed = createFixedCapabilities(workspace);

    expect(
      fixed.grants.some((grant) =>
        grantMatches(grant, realpathSync(sibling), "read"),
      ),
    ).toBe(true);
    expect(
      fixed.grants.some((grant) =>
        grantMatches(grant, realpathSync(sibling), "write"),
      ),
    ).toBe(true);
    expect(
      fixed.grants.some(
        (grant) =>
          grant.path === realpathSync(root) && grant.kind === "directory",
      ),
    ).toBe(false);
  });

  it("retains operational aliases in the manifest without changing canonical authorization", () => {
    const root = fixture();
    const canonical = join(root, "canonical");
    const alias = join(root, "alias");
    mkdirSync(canonical);
    symlinkSync(canonical, alias);

    const fixed = createFixedCapabilities(root);
    const manifest = buildNonoManifest({
      cwd: fixed.cwd,
      grants: [grant(realpathSync(canonical), "read", "directory")],
      executionGrants: [
        {
          path: alias,
          canonicalPath: realpathSync(canonical),
          access: "read",
          kind: "directory",
        },
      ],
    });

    expect(manifest.filesystem.grants).toEqual(
      expect.arrayContaining([
        { path: alias, type: "directory", access: "read" },
        { path: realpathSync(canonical), type: "directory", access: "read" },
      ]),
    );
    expect(fixed.grants.some((entry) => entry.path === alias)).toBe(false);
  });

  it("drops execution aliases that are not backed by canonical authorization", () => {
    const root = fixture();
    const canonical = join(root, "canonical");
    const alias = join(root, "alias");
    mkdirSync(canonical);
    symlinkSync(canonical, alias);

    const manifest = buildNonoManifest({
      cwd: root,
      grants: [],
      executionGrants: [
        {
          path: alias,
          canonicalPath: realpathSync(canonical),
          access: "read",
          kind: "directory",
        },
      ],
    });
    expect(manifest.filesystem.grants).toEqual([]);
  });

  it("grants validated linked-worktree Git administration without sibling worktrees", () => {
    const root = fixture();
    const target = join(root, "target");
    const linked = join(root, "linked");
    const sibling = join(root, "sibling");
    mkdirSync(target);
    execFileSync("git", ["init", "-b", "main", target]);
    execFileSync("git", ["-C", target, "config", "user.name", "Pipkin"]);
    execFileSync("git", [
      "-C",
      target,
      "config",
      "user.email",
      "pipkin@example.test",
    ]);
    writeFileSync(join(target, "tracked"), "tracked");
    execFileSync("git", ["-C", target, "add", "tracked"]);
    execFileSync("git", ["-C", target, "commit", "-m", "initial"]);
    execFileSync("git", [
      "-C",
      target,
      "worktree",
      "add",
      "-b",
      "linked",
      linked,
    ]);
    execFileSync("git", [
      "-C",
      target,
      "worktree",
      "add",
      "-b",
      "sibling",
      sibling,
    ]);

    const fixed = createFixedCapabilities(linked);
    const gitDir = realpathSync(
      execFileSync(
        "git",
        ["-C", linked, "rev-parse", "--path-format=absolute", "--git-dir"],
        { encoding: "utf-8" },
      ).trim(),
    );
    const commonDir = realpathSync(
      execFileSync(
        "git",
        [
          "-C",
          linked,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        { encoding: "utf-8" },
      ).trim(),
    );

    for (const path of [gitDir, commonDir]) {
      expect(fixed.grants).toEqual(
        expect.arrayContaining([
          { path, access: "read", kind: "directory" },
          { path, access: "write", kind: "directory" },
        ]),
      );
    }
    expect(
      fixed.grants.some((entry) => entry.path === realpathSync(sibling)),
    ).toBe(false);
  });

  it("rejects malformed linked-worktree indirection", () => {
    const root = fixture();
    const workspace = join(root, "workspace");
    const unrelated = join(root, "unrelated");
    mkdirSync(workspace);
    mkdirSync(unrelated);
    writeFileSync(join(workspace, ".git"), `gitdir: ${unrelated}\n`);

    const fixed = createFixedCapabilities(workspace);
    expect(
      fixed.grants.some((entry) => entry.path === realpathSync(unrelated)),
    ).toBe(false);
  });

  it("retains workspace-local inherited PATH roots and excludes credential config targets", () => {
    const root = fixture();
    const workspace = join(root, "workspace");
    const toolchain = join(workspace, "node_modules", ".bin");
    const home = join(root, "home");
    const credentials = join(home, ".git-credentials");
    const gitConfig = join(home, ".gitconfig");
    mkdirSync(toolchain, { recursive: true });
    mkdirSync(home);
    writeFileSync(credentials, "secret");
    symlinkSync(credentials, gitConfig);
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    process.env.HOME = home;
    process.env.PATH = toolchain;
    try {
      const fixed = createFixedCapabilities(workspace);
      expect(fixed.executionGrants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: toolchain,
            canonicalPath: realpathSync(toolchain),
          }),
        ]),
      );
      expect(isSensitiveHomeTarget(realpathSync(credentials), home)).toBe(true);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it("emits fixed grants and unrestricted network", () => {
    const root = fixture();
    const manifest = buildNonoManifest({
      cwd: root,
      grants: [
        grant(root, "read", "directory"),
        grant(root, "write", "directory"),
      ],
    });
    expect(manifest).toEqual({
      version: "0.1.0",
      filesystem: {
        grants: [{ path: root, type: "directory", access: "readwrite" }],
      },
      network: { mode: "unrestricted" },
    });
    const file = writeNonoManifest(manifest);
    expect(file.path).toMatch(
      /pipkin-nono-run-.*\/pipkin-nono-manifest\.json$/,
    );
    file.cleanup();
    file.cleanup();
  });
});
