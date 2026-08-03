import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearPipkinStatus, setPipkinStatus } from "#ui/status";
import {
  createPapercutStoreForCwd,
  onPapercutChange,
  type PapercutFile,
  type PapercutRecord,
} from "./store.js";

export const PAPERCUT_STATUS = {
  id: "papercuts",
  priority: 300,
  icon: "󰶯",
} as const;

function pendingRecords(file: PapercutFile): PapercutRecord[] {
  return file.records.filter((record) => record.status === "pending");
}

export function createPapercutStatusController() {
  async function storeFor(ctx: ExtensionContext) {
    const store = await createPapercutStoreForCwd(ctx.cwd);
    await store.initialize();
    return store;
  }

  let activeRegistryPath: string | undefined;
  let sessionActive = false;
  let sessionGeneration = 0;
  let queuedRefresh: { generation: number } | undefined;
  let unsubscribeFromPapercutChanges = () => {};

  const isActiveSession = (generation: number): boolean =>
    sessionActive && sessionGeneration === generation;

  const refreshStatus = async (
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> => {
    const sessionIsActive = () => isActiveSession(generation);
    if (!sessionIsActive() || ctx.mode !== "tui") {
      return;
    }
    try {
      const store = await storeFor(ctx);
      if (!sessionIsActive()) {
        return;
      }
      activeRegistryPath = store.registryPath;
      const file = await store.load();
      if (!sessionIsActive()) {
        return;
      }
      const count = pendingRecords(file).length;
      if (count > 0) {
        setPipkinStatus(ctx.ui, {
          ...PAPERCUT_STATUS,
          state: "warning",
          text: `${count} papercuts`,
        });
      } else {
        clearPipkinStatus(ctx.ui, PAPERCUT_STATUS.id, PAPERCUT_STATUS.priority);
      }
    } catch (error) {
      if (!sessionIsActive()) {
        return;
      }
      clearPipkinStatus(ctx.ui, PAPERCUT_STATUS.id, PAPERCUT_STATUS.priority);
      ctx.ui.notify(
        `Papercuts unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  const queueStatusRefresh = (
    ctx: ExtensionContext,
    generation: number,
  ): void => {
    if (
      !isActiveSession(generation) ||
      queuedRefresh?.generation === generation
    ) {
      return;
    }
    const queued = { generation };
    queuedRefresh = queued;
    queueMicrotask(() => {
      if (queuedRefresh !== queued) {
        return;
      }
      queuedRefresh = undefined;
      if (isActiveSession(generation)) {
        void refreshStatus(ctx, generation);
      }
    });
  };

  return {
    storeFor,
    generation: () => sessionGeneration,
    refreshStatus,
    queueStatusRefresh,
    toolResult(
      event: { isError: boolean; toolName: string; input: unknown },
      ctx: ExtensionContext,
    ): void {
      if (
        event.isError ||
        (event.toolName !== "write" && event.toolName !== "edit")
      ) {
        return;
      }
      const path = (event.input as { path?: unknown }).path;
      const generation = sessionGeneration;
      if (
        typeof path === "string" &&
        activeRegistryPath === resolve(ctx.cwd, path)
      ) {
        queueStatusRefresh(ctx, generation);
      }
    },
    async sessionStart(ctx: ExtensionContext): Promise<void> {
      const generation = ++sessionGeneration;
      sessionActive = true;
      activeRegistryPath = undefined;
      queuedRefresh = undefined;
      unsubscribeFromPapercutChanges();
      unsubscribeFromPapercutChanges = onPapercutChange((change) => {
        if (
          isActiveSession(generation) &&
          change.registryPath === activeRegistryPath
        ) {
          queueStatusRefresh(ctx, generation);
        }
      });
      await refreshStatus(ctx, generation);
    },
    sessionShutdown(ctx: ExtensionContext): void {
      if (!sessionActive) {
        return;
      }
      ++sessionGeneration;
      sessionActive = false;
      activeRegistryPath = undefined;
      queuedRefresh = undefined;
      unsubscribeFromPapercutChanges();
      unsubscribeFromPapercutChanges = () => {};
      if (ctx.mode === "tui") {
        clearPipkinStatus(ctx.ui, PAPERCUT_STATUS.id, PAPERCUT_STATUS.priority);
      }
    },
  };
}
