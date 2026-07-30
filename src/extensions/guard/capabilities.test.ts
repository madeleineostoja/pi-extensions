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
  createFilesystemGrant,
  createFixedCapabilities,
  resolvePiToolPath,
  grantMatches,
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
  effects: FilesystemGrant["effects"] = [],
): FilesystemGrant {
  return { path, access, kind, effects };
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

  it("matches Pi 0.82 path resolution and read fallback", () => {
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
    const grant = createFilesystemGrant(
      "/definitely-pipkin-missing/foo",
      "/",
      "write",
      ["outside-boundary"],
      true,
    )!;
    expect(grant).toMatchObject({
      path: "/definitely-pipkin-missing/foo",
      kind: "file",
    });
  });

  it("keeps missing mutations exact and tracks reachability and protected approval separately", () => {
    const root = fixture();
    const env = join(root, ".env.example");
    const missing = createFilesystemGrant(
      env,
      root,
      "write",
      ["outside-boundary"],
      true,
    )!;
    expect(missing.kind).toBe("file");
    expect(missing.path).toBe(canonicalizeTarget(env, root));
    expect(isProtectedReadTarget(env, missing.path, root)).toBe(true);

    const state = createGuardRuntimeState();
    state.addGrant({
      ...missing,
      access: "read",
      effects: ["outside-boundary", "protected-read"],
    });
    expect(state.allowsReachability(missing.path, "read")).toBe(true);
    expect(state.allowsProtectedRead(missing.path)).toBe(true);
    state.setBoundaryEnabled(false);
    expect(state.filesystemGrants()).toEqual([]);
    expect(state.protectedReadApprovals()).toEqual([]);
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

  it("emits only sequence grants and unrestricted network", () => {
    const root = fixture();
    const fixed = {
      cwd: root,
      grants: [
        grant(root, "read", "directory"),
        grant(root, "write", "directory"),
      ],
    };
    const outside = join(root, "outside");
    const protectedFile = join(root, ".env");
    const manifest = buildNonoManifest(fixed, [
      grant(outside, "read", "directory", ["outside-boundary"]),
      grant(protectedFile, "read", "file", ["protected-read"]),
    ]);
    expect(manifest).toEqual({
      version: "0.1.0",
      filesystem: {
        grants: [
          { path: root, type: "directory", access: "readwrite" },
          { path: outside, type: "directory", access: "read" },
        ],
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
