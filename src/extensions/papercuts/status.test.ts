import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerProposalTool } from "./proposal-tool.js";
import { createPapercutStatusController } from "./status.js";
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
const PAPERCUT_STATUS_KEY = "pipkin:status:0300:papercuts";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-papercuts-status-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function proposalTool(
  status: ReturnType<typeof createPapercutStatusController>,
) {
  let tool: any;
  registerProposalTool(
    {
      registerTool: (definition: unknown) => {
        tool = definition;
      },
    } as never,
    status,
  );
  return tool;
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

describe("papercut status", () => {
  it("refreshes durable footer status on startup, proposal, and shutdown", async () => {
    const status = createPapercutStatusController();
    const tool = proposalTool(status);
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

    await status.sessionStart(ctx as never);
    expect(setStatus).toHaveBeenLastCalledWith(PAPERCUT_STATUS_KEY, undefined);
    await tool.execute("id", proposal, undefined, undefined, ctx);
    expect(setStatus).toHaveBeenLastCalledWith(
      PAPERCUT_STATUS_KEY,
      "󰶯 1 papercuts",
    );
    status.sessionShutdown(ctx as never);
    expect(setStatus).toHaveBeenLastCalledWith(PAPERCUT_STATUS_KEY, undefined);
  });

  it("does not let a failed stale refresh notify or update a replacement session", async () => {
    const status = createPapercutStatusController();
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
    const staleStart = status.sessionStart(staleContext as never);
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
    await status.sessionStart(activeContext as never);

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
    const status = createPapercutStatusController();
    const tool = proposalTool(status);
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
    await status.sessionStart(staleContext as never);
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
    await status.sessionStart(activeContext as never);

    resolveLoad!();
    await staleProposal;

    expect(staleSetStatus).not.toHaveBeenCalled();
    expect(activeSetStatus).toHaveBeenLastCalledWith(
      PAPERCUT_STATUS_KEY,
      undefined,
    );
  });

  it("does not let an in-flight refresh update a shutdown session", async () => {
    const status = createPapercutStatusController();
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
    const start = status.sessionStart(ctx as never);
    await new Promise<void>((resolve) => {
      enterLoad = resolve;
    });

    status.sessionShutdown({ ...ctx } as never);
    resolveLoad!();
    await start;

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(PAPERCUT_STATUS_KEY, undefined);
  });

  it("does not inspect a queued context after shutdown invalidates it", async () => {
    const status = createPapercutStatusController();
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

    await status.sessionStart(startContext as never);
    status.toolResult(
      {
        toolName: "edit",
        input: { path: join(root, ".pi", "pipkin", "papercuts.json") },
        isError: false,
      },
      startContext as never,
    );
    status.sessionShutdown(makeContext() as never);
    invalidated = true;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(staleReads).toBe(0);
  });

  it("refreshes the live footer when another extension persists a papercut", async () => {
    const status = createPapercutStatusController();
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

    await status.sessionStart(ctx as never);
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
    const status = createPapercutStatusController();
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

    await status.sessionStart(ctx as never);
    expect(setStatus).toHaveBeenLastCalledWith(
      PAPERCUT_STATUS_KEY,
      "󰶯 1 papercuts",
    );
    setStatus.mockClear();

    const registry = JSON.parse(readFileSync(store.registryPath, "utf8"));
    registry.records[0].status = "resolved";
    writeFileSync(store.registryPath, JSON.stringify(registry));
    status.toolResult(
      {
        toolName: "edit",
        input: { path: store.registryPath },
        isError: false,
      },
      { ...ctx } as never,
    );

    await vi.waitFor(() => {
      expect(setStatus).toHaveBeenLastCalledWith(
        PAPERCUT_STATUS_KEY,
        undefined,
      );
    });
  });
});
