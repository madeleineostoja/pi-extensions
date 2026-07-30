import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  grant?: string;
}) {
  return buildNonoManifest(
    {
      cwd: paths.workspace,
      grants: [
        {
          path: paths.workspace,
          access: "read",
          kind: "directory",
          effects: [],
        },
        {
          path: paths.workspace,
          access: "write",
          kind: "directory",
          effects: [],
        },
        { path: paths.session, access: "read", kind: "file", effects: [] },
        {
          path: paths.introspection,
          access: "read",
          kind: "file",
          effects: [],
        },
        { path: "/bin", access: "read", kind: "directory", effects: [] },
        { path: "/usr", access: "read", kind: "directory", effects: [] },
        ...(paths.grant
          ? [
              {
                path: paths.grant,
                access: "read" as const,
                kind: "file" as const,
                effects: ["outside-boundary"] as const,
              },
            ]
          : []),
      ],
    },
    [],
  );
}

async function cat(
  binary: string,
  manifest: ReturnType<typeof writeNonoManifest>,
  path: string,
) {
  return runNono(binary, manifest, "/bin/cat", [path]);
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
  "confines the managed macOS binary to fixed, session, introspection, and explicit file capabilities",
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

    const granted = await cat(
      binary,
      writeNonoManifest(
        manifestFor({ workspace, session, introspection, grant: explicit }),
      ),
      explicit,
    );
    expect(granted).toMatchObject({
      kind: "exited",
      exitCode: 0,
      stdout: "explicit",
    });
    expect(
      manifestFor({ workspace, session, introspection, grant: explicit })
        .network,
    ).toEqual({ mode: "unrestricted" });
  },
);
