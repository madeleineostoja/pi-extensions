import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeTarget, type FixedCapabilities } from "../capabilities.js";
import { createGuardRuntimeState } from "../state.js";
import {
  filesystemPromptDetail,
  gateDirectFilesystemTool,
} from "./tool-gate.js";

const directories: string[] = [];
afterEach(() => {
  while (directories.length) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pipkin-guard-gate-"));
  directories.push(root);
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  const runtime = createGuardRuntimeState();
  const canonicalWorkspace = canonicalizeTarget(workspace, workspace);
  const fixed: FixedCapabilities = {
    cwd: canonicalWorkspace,
    grants: [
      {
        path: canonicalWorkspace,
        access: "read",
        kind: "directory",
        effects: [],
      },
      {
        path: canonicalWorkspace,
        access: "write",
        kind: "directory",
        effects: [],
      },
    ],
  };
  runtime.setFixedCapabilities(fixed);
  return { workspace, outside, runtime };
}

async function gate(options: {
  runtime: ReturnType<typeof createGuardRuntimeState>;
  cwd: string;
  path: string;
  tool?: "read" | "grep" | "find" | "ls" | "write" | "edit";
  supportedMac?: boolean;
  canPrompt?: boolean;
  choice?: "once" | "similar" | "block";
}) {
  return gateDirectFilesystemTool({
    tool: options.tool ?? "read",
    input: { path: options.path },
    cwd: options.cwd,
    supportedMac: options.supportedMac ?? true,
    canPrompt: options.canPrompt ?? true,
    state: options.runtime,
    prompt: async (request) => {
      expect(filesystemPromptDetail(request)).toContain(
        `Future ${request.grant.access} access:`,
      );
      return options.choice ?? "block";
    },
  });
}

describe("direct filesystem tool gate", () => {
  it("uses a similar grant only for later matching mode and exact file", async () => {
    const { workspace, outside, runtime } = fixture();
    const file = join(outside, "file.txt");
    const sibling = join(outside, "sibling.txt");
    writeFileSync(file, "file");
    writeFileSync(sibling, "sibling");

    expect(
      await gate({ runtime, cwd: workspace, path: file, choice: "similar" }),
    ).toEqual({});
    expect(
      await gate({ runtime, cwd: workspace, path: file, canPrompt: false }),
    ).toEqual({});
    expect(
      await gate({
        runtime,
        cwd: workspace,
        path: file,
        tool: "write",
        canPrompt: false,
      }),
    ).toMatchObject({ block: true });
    expect(
      await gate({ runtime, cwd: workspace, path: sibling, canPrompt: false }),
    ).toMatchObject({
      block: true,
    });
  });

  it("grants directory descendants but not siblings or parents", async () => {
    const { workspace, outside, runtime } = fixture();
    const directory = join(outside, "directory");
    const sibling = join(outside, "sibling");
    mkdirSync(directory);
    mkdirSync(sibling);
    writeFileSync(join(directory, "child.txt"), "child");

    expect(
      await gate({
        runtime,
        cwd: workspace,
        path: directory,
        tool: "ls",
        choice: "similar",
      }),
    ).toEqual({});
    expect(
      await gate({
        runtime,
        cwd: workspace,
        path: join(directory, "child.txt"),
        canPrompt: false,
      }),
    ).toEqual({});
    expect(
      await gate({ runtime, cwd: workspace, path: outside, canPrompt: false }),
    ).toMatchObject({
      block: true,
    });
    expect(
      await gate({ runtime, cwd: workspace, path: sibling, canPrompt: false }),
    ).toMatchObject({
      block: true,
    });
  });

  it("allows once without retaining either combined approval effect", async () => {
    const { workspace, outside, runtime } = fixture();
    const env = join(outside, "secret");
    const alias = join(workspace, ".env");
    writeFileSync(env, "secret");
    symlinkSync(env, alias);

    expect(
      await gate({ runtime, cwd: workspace, path: alias, choice: "once" }),
    ).toEqual({});
    expect(runtime.filesystemGrants()).toEqual([]);
    expect(runtime.protectedReadApprovals()).toEqual([]);
    expect(
      await gate({ runtime, cwd: workspace, path: alias, canPrompt: false }),
    ).toMatchObject({
      block: true,
    });
  });

  it("records combined approval effects independently and denies no-UI model calls", async () => {
    const { workspace, outside, runtime } = fixture();
    const env = join(outside, "secret");
    const alias = join(workspace, ".env");
    writeFileSync(env, "secret");
    symlinkSync(env, alias);

    expect(
      await gate({ runtime, cwd: workspace, path: alias, choice: "similar" }),
    ).toEqual({});
    expect(runtime.filesystemGrants()).toHaveLength(1);
    expect(runtime.protectedReadApprovals()).toHaveLength(1);
    expect(
      await gate({ runtime, cwd: workspace, path: alias, canPrompt: false }),
    ).toEqual({});

    const other = join(outside, "other.txt");
    writeFileSync(other, "other");
    expect(
      await gate({ runtime, cwd: workspace, path: other, canPrompt: false }),
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("unavailable"),
    });
  });
});
