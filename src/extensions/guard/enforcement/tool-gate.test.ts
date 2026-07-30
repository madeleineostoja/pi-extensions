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
import {
  canonicalizeTarget,
  type FixedCapabilities,
  type PiPathCompatibility,
} from "../capabilities.js";
import { createGuardRuntimeState } from "../state.js";
import {
  filesystemPromptDetail,
  gateDirectFilesystemTool,
  type FilesystemPrompt,
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
  pathCompatibility?: PiPathCompatibility;
  canPrompt?: boolean;
  choice?: "once" | "similar" | "block";
  signal?: AbortSignal;
  prompt?: FilesystemPrompt;
}) {
  return gateDirectFilesystemTool({
    tool: options.tool ?? "read",
    input: { path: options.path },
    cwd: options.cwd,
    supportedMac: options.supportedMac ?? true,
    pathCompatibility: options.pathCompatibility,
    canPrompt: options.canPrompt ?? true,
    signal: options.signal,
    state: options.runtime,
    prompt:
      options.prompt ??
      (async (request) => {
        expect(filesystemPromptDetail(request)).toContain(
          `Future ${request.grant.access} access:`,
        );
        return options.choice ?? "block";
      }),
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

  it("uses Pi-compatible paths when creating a session grant", async () => {
    const { workspace, outside, runtime } = fixture();
    const file = join(outside, "file.txt");
    writeFileSync(file, "file");

    expect(
      await gate({
        runtime,
        cwd: workspace,
        path: "~/file.txt",
        pathCompatibility: { homeDir: outside },
        choice: "similar",
      }),
    ).toEqual({});
    expect(
      await gate({
        runtime,
        cwd: workspace,
        path: file,
        canPrompt: false,
      }),
    ).toEqual({});
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

  it("blocks affirmative approvals after cancellation or session reset", async () => {
    const { workspace, outside, runtime } = fixture();
    const file = join(outside, "file.txt");
    writeFileSync(file, "file");
    const cancellation = new AbortController();
    let resolveChoice!: (choice: "once" | "similar") => void;
    const pending = new Promise<"once" | "similar">((resolve) => {
      resolveChoice = resolve;
    });

    const canceled = gate({
      runtime,
      cwd: workspace,
      path: file,
      signal: cancellation.signal,
      prompt: async () => pending,
    });
    cancellation.abort();
    resolveChoice("once");
    await expect(canceled).resolves.toMatchObject({ block: true });

    let resolveReset!: (choice: "similar") => void;
    const pendingReset = new Promise<"similar">((resolve) => {
      resolveReset = resolve;
    });
    const reset = gate({
      runtime,
      cwd: workspace,
      path: file,
      prompt: async () => pendingReset,
    });
    runtime.resetSession();
    resolveReset("similar");
    await expect(reset).resolves.toMatchObject({ block: true });
    expect(runtime.filesystemGrants()).toEqual([]);
    expect(runtime.protectedReadApprovals()).toEqual([]);
  });

  it("blocks protected reads after session shutdown without prompting", async () => {
    const { workspace, runtime } = fixture();
    const protectedFile = join(workspace, ".env");
    writeFileSync(protectedFile, "secret");
    let prompts = 0;
    const prompt: FilesystemPrompt = async () => {
      prompts += 1;
      return "similar";
    };

    await expect(
      gate({
        runtime,
        cwd: workspace,
        path: protectedFile,
        supportedMac: false,
        prompt,
      }),
    ).resolves.toEqual({});
    expect(prompts).toBe(1);
    runtime.resetSession();
    await expect(
      gate({
        runtime,
        cwd: workspace,
        path: protectedFile,
        supportedMac: false,
        prompt,
      }),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("active session"),
    });

    const boundaryDisabled = fixture();
    const disabledProtectedFile = join(boundaryDisabled.workspace, ".env");
    writeFileSync(disabledProtectedFile, "secret");
    boundaryDisabled.runtime.setBoundaryEnabled(false);
    boundaryDisabled.runtime.resetSession();
    await expect(
      gate({
        runtime: boundaryDisabled.runtime,
        cwd: boundaryDisabled.workspace,
        path: disabledProtectedFile,
        prompt,
      }),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("active session"),
    });

    expect(prompts).toBe(1);
    expect(runtime.protectedReadApprovals()).toEqual([]);
    expect(boundaryDisabled.runtime.protectedReadApprovals()).toEqual([]);
  });

  it("blocks stale approvals across either boundary transition", async () => {
    const { workspace, outside, runtime } = fixture();
    const file = join(outside, "file.txt");
    const protectedFile = join(workspace, ".env");
    writeFileSync(file, "file");
    writeFileSync(protectedFile, "secret");
    let resolveChoice!: (choice: "similar") => void;
    const pending = new Promise<"similar">((resolve) => {
      resolveChoice = resolve;
    });

    const disabled = gate({
      runtime,
      cwd: workspace,
      path: file,
      prompt: async () => pending,
    });
    runtime.setBoundaryEnabled(false);
    resolveChoice("similar");
    await expect(disabled).resolves.toMatchObject({ block: true });
    expect(runtime.filesystemGrants()).toEqual([]);

    let resolveEnabled!: (choice: "similar") => void;
    const pendingEnabled = new Promise<"similar">((resolve) => {
      resolveEnabled = resolve;
    });
    const enabled = gate({
      runtime,
      cwd: workspace,
      path: protectedFile,
      supportedMac: false,
      prompt: async () => pendingEnabled,
    });
    runtime.setBoundaryEnabled(true);
    resolveEnabled("similar");
    await expect(enabled).resolves.toMatchObject({ block: true });
    expect(runtime.filesystemGrants()).toEqual([]);
    expect(runtime.protectedReadApprovals()).toEqual([]);
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
