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
      { path: canonicalWorkspace, access: "read", kind: "directory" },
      { path: canonicalWorkspace, access: "write", kind: "directory" },
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
  choice?: "once" | "block";
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
          `Access: ${request.access} ${request.target}`,
        );
        return options.choice ?? "block";
      }),
  });
}

describe("direct filesystem tool gate", () => {
  it("allows only the current access and prompts again later", async () => {
    const { workspace, outside, runtime } = fixture();
    const file = join(outside, "file.txt");
    writeFileSync(file, "file");
    let prompts = 0;
    const prompt: FilesystemPrompt = async () => {
      prompts += 1;
      return "once";
    };

    await expect(
      gate({ runtime, cwd: workspace, path: file, prompt }),
    ).resolves.toEqual({});
    await expect(
      gate({ runtime, cwd: workspace, path: file, prompt }),
    ).resolves.toEqual({});
    expect(prompts).toBe(2);
    await expect(
      gate({ runtime, cwd: workspace, path: file, canPrompt: false }),
    ).resolves.toMatchObject({ block: true });
  });

  it("describes combined sandbox and protected-read reasons", async () => {
    const { workspace, outside, runtime } = fixture();
    const secret = join(outside, "secret");
    const file = join(workspace, ".env");
    writeFileSync(secret, "secret");
    symlinkSync(secret, file);
    let detail = "";

    await gate({
      runtime,
      cwd: workspace,
      path: file,
      prompt: async (request) => {
        detail = filesystemPromptDetail(request);
        return "block";
      },
    });

    expect(detail).toContain("outside the filesystem sandbox");
    expect(detail).toContain("protected explicit read");
    expect(detail).not.toContain("Future");
  });

  it("blocks approvals after cancellation, reset, or a sandbox transition", async () => {
    const { workspace, outside, runtime } = fixture();
    const file = join(outside, "file.txt");
    writeFileSync(file, "file");

    for (const invalidate of [
      (signal: AbortController) => signal.abort(),
      () => runtime.resetSession(),
      () => runtime.setBoundaryEnabled(false),
    ]) {
      runtime.setFixedCapabilities({
        cwd: canonicalizeTarget(workspace, workspace),
        grants: [
          {
            path: canonicalizeTarget(workspace, workspace),
            access: "read",
            kind: "directory",
          },
        ],
      });
      runtime.setBoundaryEnabled(true);
      const cancellation = new AbortController();
      let resolveChoice!: (choice: "once") => void;
      const pending = new Promise<"once">((resolve) => {
        resolveChoice = resolve;
      });
      const result = gate({
        runtime,
        cwd: workspace,
        path: file,
        signal: cancellation.signal,
        prompt: async () => pending,
      });
      invalidate(cancellation);
      resolveChoice("once");
      await expect(result).resolves.toMatchObject({ block: true });
    }
  });

  it("blocks outside an active interactive session without prompting", async () => {
    const { workspace, outside, runtime } = fixture();
    const file = join(outside, "file.txt");
    writeFileSync(file, "file");
    let prompts = 0;
    const prompt: FilesystemPrompt = async () => {
      prompts += 1;
      return "once";
    };

    await expect(
      gate({
        runtime,
        cwd: workspace,
        path: file,
        canPrompt: false,
        prompt,
      }),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("interactive TUI"),
    });
    runtime.resetSession();
    const protectedFile = join(workspace, ".env");
    writeFileSync(protectedFile, "secret");
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
    expect(prompts).toBe(0);
  });
});
