import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPapercutSummary, registerPapercutsBrowser } from "./browser.js";
import {
  PapercutProposalSchema,
  registerProposalTool,
} from "./proposal-tool.js";
import {
  createPapercutStatusController,
  PAPERCUT_STATUS_KEY,
} from "./status.js";
import { createPapercutStore } from "./store.js";

const loadGate = vi.hoisted(() => ({
  current: undefined as
    | { entered: () => void; promise: Promise<void> }
    | undefined,
}));

vi.mock("./store.js", async (importOriginal) => {
  const store = await importOriginal<typeof import("./store.js")>();
  const delayLoad = (
    papercutStore: ReturnType<typeof store.createPapercutStore>,
  ) => ({
    ...papercutStore,
    load: async () => {
      const gate = loadGate.current;
      gate?.entered();
      if (gate) {
        await gate.promise;
      }
      return papercutStore.load();
    },
  });
  return {
    ...store,
    createPapercutStore: (
      ...args: Parameters<typeof store.createPapercutStore>
    ) => delayLoad(store.createPapercutStore(...args)),
    createPapercutStoreForCwd: async (
      ...args: Parameters<typeof store.createPapercutStoreForCwd>
    ) => delayLoad(await store.createPapercutStoreForCwd(...args)),
  };
});

const roots: string[] = [];

function registerExtension(pi: any): void {
  const status = createPapercutStatusController();
  registerProposalTool(pi, status);
  registerPapercutsBrowser(pi, status);
  pi.on("tool_result", (event: any, ctx: any) => status.toolResult(event, ctx));
  pi.on("session_start", (_event: any, ctx: any) => status.sessionStart(ctx));
  pi.on("session_shutdown", (_event: any, ctx: any) =>
    status.sessionShutdown(ctx),
  );
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-papercuts-extension-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

afterEach(() => {
  loadGate.current = undefined;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const proposal = {
  key: "devcontainer-validation",
  title: "Validation needs the devcontainer",
  trigger: "Ruby validation runs on the host",
  impact: "Future sessions waste time",
  currentGap: "No preflight instruction exists",
  proposedResolution: "Add a preflight",
  suggestedDestination: "agents" as const,
};

describe("pipkin-papercuts extension", () => {
  it("registers a host-only proposal tool with required concrete fields and no guidelines", () => {
    let tool: any;
    const pi = {
      registerTool: (definition: unknown) => {
        tool = definition;
      },
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerExtension(pi as never);

    expect(tool.name).toBe("propose_papercut");
    expect(tool.promptSnippet).toContain("propose_papercut");
    expect(tool).not.toHaveProperty("promptGuidelines");
    expect(tool.description).toContain("expected intermediate");
    expect(tool.description).toContain("ordinary self-corrected");
    expect(tool.description).toContain("correctly anticipated and handled");
    expect(tool.parameters.required).toEqual(
      expect.arrayContaining(["currentGap", "proposedResolution"]),
    );
    expect(PapercutProposalSchema.required).toEqual(
      expect.arrayContaining(["currentGap", "proposedResolution"]),
    );
  });

  it("rejects malformed runtime proposals without persisting them", async () => {
    let tool: any;
    const pi = {
      registerTool: (definition: unknown) => {
        tool = definition;
      },
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerExtension(pi as never);
    const root = repo();
    const ctx = {
      cwd: root,
      mode: "json",
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };

    const result = await tool.execute(
      "id",
      { ...proposal, impact: 42 },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toContain("Papercut rejected");
    expect(result.details.kind).toBe("rejected");
  });

  it("reports every durable proposal outcome without editing project source", async () => {
    let tool: any;
    const pi = {
      registerTool: (definition: unknown) => {
        tool = definition;
      },
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerExtension(pi as never);
    const root = repo();
    const ctx = {
      cwd: root,
      mode: "json",
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };

    await expect(
      tool.execute("created", proposal, undefined, undefined, ctx),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringContaining("Papercut created"),
        }),
      ],
      details: { kind: "created" },
    });
    await expect(
      tool.execute("merged", proposal, undefined, undefined, ctx),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringContaining("Papercut merged into pending"),
        }),
      ],
      details: { kind: "merged" },
    });
    const store = createPapercutStore(root);
    await store.transition(proposal.key, "ignored", { note: "not now" });
    await expect(
      tool.execute("ignored", proposal, undefined, undefined, ctx),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringContaining("Papercut already ignored"),
        }),
      ],
      details: { kind: "ignored" },
    });
    await store.transition(proposal.key, "resolved", { target: "AGENTS.md" });
    await expect(
      tool.execute("resolved", proposal, undefined, undefined, ctx),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringContaining("Papercut already resolved"),
        }),
      ],
      details: { kind: "resolved" },
    });
  });

  it("refreshes durable footer status on startup, proposal, and shutdown", async () => {
    let tool: any;
    let command: any;
    const handlers = new Map<string, any>();
    const pi = {
      registerTool: (definition: unknown) => {
        tool = definition;
      },
      registerCommand: (_name: string, definition: unknown) => {
        command = definition;
      },
      on: (event: string, handler: unknown) => handlers.set(event, handler),
    };
    registerExtension(pi as never);
    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: repo(),
      mode: "tui",
      hasUI: true,
      ui: {
        notify,
        setStatus,
        theme: { fg: (_color: string, text: string) => text },
      },
    };

    await handlers.get("session_start")({}, ctx);
    expect(setStatus).toHaveBeenLastCalledWith(PAPERCUT_STATUS_KEY, undefined);
    await tool.execute("id", proposal, undefined, undefined, ctx);
    expect(setStatus).toHaveBeenLastCalledWith(
      PAPERCUT_STATUS_KEY,
      "󰶯 1 papercuts",
    );
    handlers.get("session_shutdown")({}, { ...ctx });
    expect(setStatus).toHaveBeenLastCalledWith(PAPERCUT_STATUS_KEY, undefined);

    await command.handler("unexpected", { ...ctx, mode: "json", hasUI: false });
    expect(notify).toHaveBeenLastCalledWith("usage: /papercuts", "warning");
  });

  it("does not let a failed stale refresh notify or update a replacement session", async () => {
    const handlers = new Map<string, any>();
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: (event: string, handler: unknown) => handlers.set(event, handler),
    };
    registerExtension(pi as never);
    let enterLoad!: () => void;
    let rejectLoad!: (error: Error) => void;
    loadGate.current = {
      entered: () => enterLoad(),
      promise: new Promise<void>((_resolve, reject) => {
        rejectLoad = reject;
      }),
    };
    const staleSetStatus = vi.fn();
    const staleNotify = vi.fn();
    const staleContext = {
      cwd: repo(),
      mode: "tui",
      hasUI: true,
      ui: {
        notify: staleNotify,
        setStatus: staleSetStatus,
        theme: { fg: (_color: string, text: string) => text },
      },
    };
    const staleStart = handlers.get("session_start")({}, staleContext);
    await new Promise<void>((resolve) => {
      enterLoad = resolve;
    });
    loadGate.current = undefined;
    const activeSetStatus = vi.fn();
    const activeContext = {
      ...staleContext,
      cwd: repo(),
      ui: {
        notify: vi.fn(),
        setStatus: activeSetStatus,
        theme: staleContext.ui.theme,
      },
    };
    await handlers.get("session_start")({}, activeContext);

    rejectLoad!(new Error("registry unavailable"));
    await staleStart;

    expect(staleSetStatus).not.toHaveBeenCalled();
    expect(staleNotify).not.toHaveBeenCalled();
    expect(activeSetStatus).toHaveBeenLastCalledWith(
      PAPERCUT_STATUS_KEY,
      undefined,
    );
  });

  it("does not let a proposal refresh update a replacement session", async () => {
    let tool: any;
    const handlers = new Map<string, any>();
    const pi = {
      registerTool: (definition: unknown) => {
        tool = definition;
      },
      registerCommand: vi.fn(),
      on: (event: string, handler: unknown) => handlers.set(event, handler),
    };
    registerExtension(pi as never);
    const staleSetStatus = vi.fn();
    const staleContext = {
      cwd: repo(),
      mode: "tui",
      hasUI: true,
      ui: {
        notify: vi.fn(),
        setStatus: staleSetStatus,
        theme: { fg: (_color: string, text: string) => text },
      },
    };
    await handlers.get("session_start")({}, staleContext);
    staleSetStatus.mockClear();

    let enterLoad!: () => void;
    let resolveLoad!: () => void;
    loadGate.current = {
      entered: () => enterLoad(),
      promise: new Promise<void>((resolve) => {
        resolveLoad = resolve;
      }),
    };
    const staleProposal = tool.execute(
      "id",
      proposal,
      undefined,
      undefined,
      staleContext,
    );
    await new Promise<void>((resolve) => {
      enterLoad = resolve;
    });

    loadGate.current = undefined;
    const activeSetStatus = vi.fn();
    const activeContext = {
      ...staleContext,
      cwd: repo(),
      ui: {
        notify: vi.fn(),
        setStatus: activeSetStatus,
        theme: staleContext.ui.theme,
      },
    };
    await handlers.get("session_start")({}, activeContext);

    resolveLoad!();
    await staleProposal;

    expect(staleSetStatus).not.toHaveBeenCalled();
    expect(activeSetStatus).toHaveBeenLastCalledWith(
      PAPERCUT_STATUS_KEY,
      undefined,
    );
  });

  it("does not let an in-flight refresh update a shutdown session", async () => {
    const handlers = new Map<string, any>();
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: (event: string, handler: unknown) => handlers.set(event, handler),
    };
    registerExtension(pi as never);
    let enterLoad!: () => void;
    let resolveLoad!: () => void;
    loadGate.current = {
      entered: () => enterLoad(),
      promise: new Promise<void>((resolve) => {
        resolveLoad = resolve;
      }),
    };
    const setStatus = vi.fn();
    const ctx = {
      cwd: repo(),
      mode: "tui",
      hasUI: true,
      ui: {
        notify: vi.fn(),
        setStatus,
        theme: { fg: (_color: string, text: string) => text },
      },
    };
    const start = handlers.get("session_start")({}, ctx);
    await new Promise<void>((resolve) => {
      enterLoad = resolve;
    });

    handlers.get("session_shutdown")({}, { ...ctx });
    resolveLoad!();
    await start;

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(PAPERCUT_STATUS_KEY, undefined);
  });

  it("does not inspect a queued context after shutdown invalidates it", async () => {
    const handlers = new Map<string, any>();
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: (event: string, handler: unknown) => handlers.set(event, handler),
    };
    registerExtension(pi as never);
    const root = repo();
    const setStatus = vi.fn();
    let invalidated = false;
    let staleReads = 0;
    const guarded =
      <T>(value: T) =>
      () => {
        if (invalidated) {
          staleReads += 1;
          throw new Error("stale extension context");
        }
        return value;
      };
    const makeContext = () =>
      Object.defineProperties(
        {},
        {
          cwd: { get: guarded(root) },
          mode: { get: guarded("tui") },
          hasUI: { get: guarded(true) },
          ui: {
            get: guarded({
              notify: vi.fn(),
              setStatus,
              theme: { fg: (_color: string, text: string) => text },
            }),
          },
        },
      );
    const startContext = makeContext();

    await handlers.get("session_start")({}, startContext);
    handlers.get("tool_result")(
      {
        toolName: "edit",
        input: { path: join(root, ".pi", "pipkin", "papercuts.json") },
        isError: false,
      },
      startContext,
    );
    handlers.get("session_shutdown")({}, makeContext());
    invalidated = true;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(staleReads).toBe(0);
  });

  it("refreshes the live footer when another extension persists a papercut", async () => {
    const handlers = new Map<string, any>();
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: (event: string, handler: unknown) => handlers.set(event, handler),
    };
    registerExtension(pi as never);
    const root = repo();
    const setStatus = vi.fn();
    const ctx = {
      cwd: root,
      mode: "tui",
      hasUI: true,
      ui: {
        notify: vi.fn(),
        setStatus,
        theme: { fg: (_color: string, text: string) => text },
      },
    };

    await handlers.get("session_start")({}, ctx);
    await createPapercutStore(root).propose(proposal, {
      kind: "pipkin:implement",
      runId: "run-1",
      role: "implementer",
    });
    await vi.waitFor(() => {
      expect(setStatus).toHaveBeenLastCalledWith(
        PAPERCUT_STATUS_KEY,
        "󰶯 1 papercuts",
      );
    });
  });

  it("refreshes the footer after a successful direct registry edit", async () => {
    const handlers = new Map<string, any>();
    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      on: (event: string, handler: unknown) => handlers.set(event, handler),
    };
    registerExtension(pi as never);
    const root = repo();
    const store = createPapercutStore(root);
    await store.propose(proposal, { kind: "agent" });
    const setStatus = vi.fn();
    const ctx = {
      cwd: root,
      mode: "tui",
      hasUI: true,
      ui: {
        notify: vi.fn(),
        setStatus,
        theme: { fg: (_color: string, text: string) => text },
      },
    };

    await handlers.get("session_start")({}, ctx);
    expect(setStatus).toHaveBeenLastCalledWith(
      PAPERCUT_STATUS_KEY,
      "󰶯 1 papercuts",
    );
    setStatus.mockClear();

    const registry = JSON.parse(readFileSync(store.registryPath, "utf8"));
    registry.records[0].status = "resolved";
    writeFileSync(store.registryPath, JSON.stringify(registry));
    handlers.get("tool_result")(
      {
        toolName: "edit",
        input: { path: store.registryPath },
        isError: false,
      },
      { ...ctx },
    );

    await vi.waitFor(() => {
      expect(setStatus).toHaveBeenLastCalledWith(
        PAPERCUT_STATUS_KEY,
        undefined,
      );
    });
  });

  it("runs every menu action durably and leaves Work on this unchanged", async () => {
    let command: any;
    const pi = {
      registerTool: vi.fn(),
      registerCommand: (_name: string, definition: unknown) => {
        command = definition;
      },
      on: vi.fn(),
    };
    registerExtension(pi as never);
    const root = repo();
    const store = createPapercutStore(root);
    await store.propose(proposal, { kind: "agent" });
    const notify = vi.fn();
    const setEditorText = vi.fn();
    const setStatus = vi.fn();
    const theme = { fg: (_color: string, text: string) => text };
    const runAction = async (
      selections: string[],
      inputs: string[] = [],
      confirmed = true,
    ) => {
      const select = vi.fn(async () => selections.shift());
      const input = vi.fn(async () => inputs.shift());
      await command.handler("", {
        cwd: root,
        mode: "tui",
        hasUI: true,
        ui: {
          select,
          input,
          confirm: vi.fn(async () => confirmed),
          notify,
          setEditorText,
          setStatus,
          theme,
        },
      });
    };
    const pending = () => [
      "Pending (1)",
      `${proposal.key} — ${proposal.title}`,
    ];

    await runAction([...pending(), "Work on this", "Close"]);
    expect(setEditorText).toHaveBeenLastCalledWith(
      expect.stringContaining(
        "Do not change this papercut's status automatically",
      ),
    );
    expect((await store.load()).records[0]).toMatchObject({
      status: "pending",
    });

    await runAction(
      [...pending(), "Mark resolved", "Close"],
      ["fixed", "docs"],
    );
    expect((await store.load()).records[0]).toMatchObject({
      status: "resolved",
      disposition: { note: "fixed", target: "docs" },
    });
    await runAction([
      "Resolved (1)",
      `${proposal.key} — ${proposal.title}`,
      "Reopen",
      "Close",
    ]);
    expect((await store.load()).records[0]).toMatchObject({
      status: "pending",
    });

    await runAction([...pending(), "Ignore", "Close"], ["defer", "backlog"]);
    expect((await store.load()).records[0]).toMatchObject({
      status: "ignored",
      disposition: { note: "defer", target: "backlog" },
    });
    await runAction([
      "Ignored (1)",
      `${proposal.key} — ${proposal.title}`,
      "Reopen",
      "Close",
    ]);

    await runAction(
      [...pending(), "Edit proposal", "Close"],
      [
        proposal.key,
        "Improved title",
        proposal.trigger,
        proposal.impact,
        proposal.currentGap,
        proposal.proposedResolution,
        proposal.suggestedDestination,
      ],
    );
    expect((await store.load()).records[0]).toMatchObject({
      title: "Improved title",
    });
    await runAction([
      "Pending (1)",
      `${proposal.key} — Improved title`,
      "Delete",
      "Close",
    ]);
    expect((await store.load()).records).toEqual([]);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("prints populated deterministic summaries without opening a modal", async () => {
    let command: any;
    const pi = {
      registerTool: vi.fn(),
      registerCommand: (_name: string, definition: unknown) => {
        command = definition;
      },
      on: vi.fn(),
    };
    registerExtension(pi as never);
    const root = repo();
    await createPapercutStore(root).propose(proposal, { kind: "agent" });
    const notify = vi.fn();
    await command.handler("", {
      cwd: root,
      mode: "json",
      hasUI: false,
      ui: { notify, setStatus: vi.fn() },
    });
    expect(notify).toHaveBeenCalledWith(
      "pending (1)\n- devcontainer-validation: Validation needs the devcontainer (1)\nignored (0)\nresolved (0)",
      "info",
    );
  });

  it("formats deterministic pending-first non-TUI summaries", () => {
    expect(
      formatPapercutSummary({
        version: 1,
        records: [
          {
            ...proposal,
            key: "z",
            status: "resolved",
            occurrences: 1,
            firstSeenAt: "a",
            lastSeenAt: "a",
            sources: [],
          },
          {
            ...proposal,
            key: "a",
            status: "pending",
            occurrences: 2,
            firstSeenAt: "a",
            lastSeenAt: "a",
            sources: [],
          },
        ],
      }),
    ).toBe(
      "pending (1)\n- a: Validation needs the devcontainer (2)\nignored (0)\nresolved (1)\n- z: Validation needs the devcontainer (1)",
    );
    expect(PAPERCUT_STATUS_KEY).toBe("pipkin.papercuts.status");
  });
});
