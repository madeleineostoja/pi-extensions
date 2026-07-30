import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildNonoManifest, runNono, writeNonoManifest } from "./manifest.js";
import { getNonoHealth, getNonoTarget, managedNonoPath } from "./nono.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

function manifestFor(paths: {
  workspace: string;
  session: string;
  introspection: string;
}) {
  return buildNonoManifest({
    cwd: paths.workspace,
    grants: [
      { path: paths.workspace, access: "read", kind: "directory" },
      { path: paths.workspace, access: "write", kind: "directory" },
      { path: paths.session, access: "read", kind: "file" },
      { path: paths.introspection, access: "read", kind: "file" },
      { path: "/bin", access: "read", kind: "directory" },
      { path: "/usr", access: "read", kind: "directory" },
    ],
  });
}

async function cat(
  binary: string,
  manifest: ReturnType<typeof writeNonoManifest>,
  path: string,
) {
  return runNono(binary, manifest, "/bin/cat", [path]);
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it.runIf(getNonoTarget() !== null)(
  "classifies the managed macOS confinement probe as healthy",
  async () => {
    await expect(getNonoHealth()).resolves.toEqual({
      kind: "healthy",
      path: managedNonoPath(),
    });
  },
);

it.runIf(getNonoTarget() !== null)(
  "confines a supported-macOS agent manifest to fixed capabilities",
  async () => {
    const binary = managedNonoPath();
    if (!binary) {
      throw new Error("Missing supported Nono target");
    }
    const root = mkdtempSync(join(tmpdir(), "pipkin-nono-contract-"));
    directories.push(root);
    const workspace = join(root, "workspace");
    const sibling = join(root, "sibling");
    mkdirSync(workspace);
    mkdirSync(sibling);
    const workspaceFile = join(workspace, "allowed");
    const session = join(root, "current-session.jsonl");
    const siblingSession = join(root, "sibling-session.jsonl");
    const introspection = join(root, "pi-introspection.json");
    const auth = join(root, "auth.json");
    const explicit = join(root, "explicit-grant");
    for (const [path, content] of [
      [workspaceFile, "workspace"],
      [session, "current-session"],
      [siblingSession, "sibling-session"],
      [introspection, "pi-introspection"],
      [auth, "auth"],
      [explicit, "explicit"],
    ] as const) {
      writeFileSync(path, content, { mode: 0o600 });
    }
    for (const [path, content] of [
      [workspaceFile, "workspace"],
      [session, "current-session"],
      [introspection, "pi-introspection"],
    ] as const) {
      const result = await cat(
        binary,
        writeNonoManifest(manifestFor({ workspace, session, introspection })),
        path,
      );
      expect(result).toMatchObject({
        kind: "exited",
        exitCode: 0,
        stdout: content,
      });
    }

    for (const path of [sibling, siblingSession, auth, explicit]) {
      const result = await cat(
        binary,
        writeNonoManifest(manifestFor({ workspace, session, introspection })),
        path,
      );
      expect(result).toMatchObject({ kind: "exited", exitCode: 1 });
      expect(result.kind === "exited" ? result.stderr : "").toMatch(
        /operation not permitted|permission denied/i,
      );
    }

    expect(manifestFor({ workspace, session, introspection }).network).toEqual({
      mode: "unrestricted",
    });
  },
);

it.runIf(getNonoTarget() !== null)(
  "cancels the supported-macOS process tree and removes its staged manifest",
  async () => {
    const binary = managedNonoPath();
    if (!binary) {
      throw new Error("Missing supported Nono target");
    }
    const root = mkdtempSync(join(tmpdir(), "pipkin-nono-cancel-"));
    directories.push(root);
    const workspace = join(root, "workspace");
    const session = join(root, "current-session.jsonl");
    const introspection = join(root, "pi-introspection.json");
    const childPid = join(workspace, "child.pid");
    mkdirSync(workspace);
    writeFileSync(session, "session");
    writeFileSync(introspection, "introspection");
    const manifest = writeNonoManifest(
      manifestFor({ workspace, session, introspection }),
    );
    const controller = new AbortController();
    const run = runNono(
      binary,
      manifest,
      "/bin/sh",
      ["-c", `sleep 30 & echo $! > ${childPid}; wait`],
      { signal: controller.signal },
    );
    await waitForFile(childPid);
    const pid = Number(readFileSync(childPid, "utf8"));
    controller.abort();
    await expect(run).resolves.toEqual({ kind: "cancelled" });
    expect(existsSync(manifest.path)).toBe(false);
    expect(processExists(pid)).toBe(false);
  },
);
