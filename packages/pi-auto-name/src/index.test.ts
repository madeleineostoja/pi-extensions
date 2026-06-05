import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import registerExtension from "./index.js";
import { readConfig } from "./config.js";

const getAgentDirMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    getAgentDir: getAgentDirMock,
  };
});

function makeFakePi() {
  const commands: Record<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void>
  > = {};

  const pi = {
    on: () => {},
    registerCommand: (
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => {
      commands[name] = options.handler;
    },
    getSessionName: () => undefined,
    setSessionName: () => {},
  } as unknown as ExtensionAPI;

  registerExtension(pi);
  return { commands };
}

function makeCommandCtx(options: { modelFound: boolean }) {
  const notifications: { message: string; type?: "info" | "warning" }[] = [];
  const ctx = {
    ui: {
      notify: (message: string, type?: "info" | "warning") => {
        notifications.push({ message, type });
      },
    },
    modelRegistry: {
      find: () => (options.modelFound ? {} : undefined),
    },
  } as unknown as ExtensionCommandContext;

  return { ctx, notifications };
}

describe("auto-name command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-auto-name-"));
    getAgentDirMock.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("persists the configured model to global user config", async () => {
    const { commands } = makeFakePi();
    const { ctx, notifications } = makeCommandCtx({ modelFound: true });

    await commands["auto-name"]("openrouter/openai/gpt-oss-20b", ctx);

    expect(readConfig(tmpDir)).toEqual({
      model: "openrouter/openai/gpt-oss-20b",
    });
    expect(notifications).toEqual([
      {
        message: "pi-auto-name model set: openrouter/openai/gpt-oss-20b",
        type: "info",
      },
    ]);
  });

  it("does not persist an unknown model", async () => {
    const { commands } = makeFakePi();
    const { ctx, notifications } = makeCommandCtx({ modelFound: false });

    await commands["auto-name"]("openrouter/openai/gpt-oss-20b", ctx);

    expect(readConfig(tmpDir)).toEqual({});
    expect(notifications).toEqual([
      {
        message: "Model not found: openrouter/openai/gpt-oss-20b",
        type: "warning",
      },
    ]);
  });
});
