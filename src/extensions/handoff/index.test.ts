import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerHandoff from "./index.js";
import { ATTEMPT_TYPE, attemptFromEntry } from "./state.js";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    BorderedLoader: class {
      signal = new AbortController().signal;
      onAbort: (() => void) | undefined;
    },
  };
});

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

type HandoffHarness = {
  command: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  ctx: ExtensionCommandContext;
  parent: SessionManager;
  parentPath: string;
  provider: { streamSimple: ReturnType<typeof vi.fn> };
  notifications: string[];
};

async function createHarness(
  options: { sourceAvailable?: boolean } = {},
): Promise<HandoffHarness> {
  const directory = await mkdtemp(join(tmpdir(), "pipkin-handoff-runtime-"));
  directories.push(directory);
  const parent = SessionManager.create(directory, directory);
  parent.appendModelChange("target", "two");
  const parentPath = parent.getSessionFile();
  if (!parentPath) {
    throw new Error("Expected persisted parent session.");
  }
  const commands = new Map<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void>
  >();
  const events = new Map<string, (event: never, ctx: never) => Promise<void>>();
  const provider = {
    streamSimple: vi.fn(() => ({
      result: async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "Reviewed continuation." }],
      }),
    })),
  };
  const pi = {
    on: (name: string, handler: (event: never, ctx: never) => Promise<void>) =>
      events.set(name, handler),
    registerCommand: (
      name: string,
      definition: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => commands.set(name, definition.handler),
    appendEntry: (type: string, data: unknown) => {
      parent.appendCustomEntry(type, data);
      writeFileSync(
        parentPath,
        [parent.getHeader(), ...parent.getEntries()]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
    },
  } as unknown as ExtensionAPI;
  registerHandoff(pi);
  const notifications: string[] = [];
  const source = { provider: "source", id: "one" };
  const target = { provider: "target", id: "two" };
  const ctx = {
    mode: "tui",
    cwd: directory,
    model: target,
    sessionManager: parent,
    modelRegistry: {
      find: vi.fn(() =>
        options.sourceAvailable === false ? undefined : source,
      ),
      getProvider: vi.fn(() => provider),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key" })),
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: (
        factory: (
          tui: never,
          theme: never,
          keys: never,
          done: (value: string) => void,
        ) => unknown,
      ) =>
        new Promise<string>((resolve) => {
          factory({} as never, {} as never, {} as never, resolve);
        }),
      editor: vi.fn(async () => "Reviewed continuation."),
    },
    switchSession: vi.fn(async () => ({ cancelled: false })),
  } as unknown as ExtensionCommandContext;
  await events.get("model_select")?.(
    { source: "set", previousModel: source, model: target } as never,
    ctx as never,
  );
  const command = commands.get("handoff");
  if (!command) {
    throw new Error("Handoff command was not registered.");
  }
  return { command, ctx, parent, parentPath, provider, notifications };
}

describe("handoff runtime", () => {
  it("uses the captured source model and creates an isolated durable child", async () => {
    const harness = await createHarness();

    await harness.command("focus", harness.ctx);

    expect(harness.provider.streamSimple).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "source", id: "one" }),
      expect.anything(),
      expect.anything(),
    );
    const attempt = harness.parent
      .getBranch()
      .map(attemptFromEntry)
      .find((entry) => entry?.entry.customType === ATTEMPT_TYPE);
    expect(attempt?.data.status).toBe("committed");
    if (!attempt || attempt.data.status !== "committed") {
      throw new Error("Expected committed handoff attempt.");
    }
    const child = SessionManager.open(
      attempt.data.childPath,
      harness.parent.getSessionDir(),
    );
    expect(child.getHeader()).toMatchObject({
      cwd: harness.ctx.cwd,
      parentSession: harness.parentPath,
    });
    expect(child.getEntries()).toHaveLength(2);
    expect(harness.ctx.switchSession).toHaveBeenCalledWith(
      attempt.data.childPath,
    );
  });

  it("does not fall back to the target when the captured source is unavailable", async () => {
    const harness = await createHarness({ sourceAvailable: false });

    await harness.command("", harness.ctx);

    expect(harness.provider.streamSimple).not.toHaveBeenCalled();
    expect(harness.parent.getBranch().map(attemptFromEntry)).not.toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ status: "committed" }),
      }),
    );
    expect(harness.notifications).toContain(
      "Handoff cancelled: captured source model is unavailable.",
    );
  });
});
