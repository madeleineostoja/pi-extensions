import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearPipkinStatus, setPipkinStatus } from "#ui/status";
import { createPapercutStoreForCwd, type PapercutFile } from "./store.js";

export const PAPERCUT_STATUS = {
  id: "papercuts",
  priority: 300,
  icon: "󰶯",
} as const;

function openCount(file: PapercutFile): number {
  return file.records.filter((record) => record.status === "open").length;
}

export function createPapercutStatusController() {
  async function storeFor(ctx: ExtensionContext) {
    const store = await createPapercutStoreForCwd(ctx.cwd);
    await store.initialize();
    return store;
  }

  async function refreshStatus(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      return;
    }
    try {
      const count = openCount(await (await storeFor(ctx)).load());
      if (count) {
        setPipkinStatus(ctx.ui, {
          ...PAPERCUT_STATUS,
          state: "warning",
          text: `${count} papercuts`,
        });
      } else {
        clearPipkinStatus(ctx.ui, PAPERCUT_STATUS.id, PAPERCUT_STATUS.priority);
      }
    } catch {
      clearPipkinStatus(ctx.ui, PAPERCUT_STATUS.id, PAPERCUT_STATUS.priority);
    }
  }

  return {
    storeFor,
    refreshStatus,
    sessionStart: refreshStatus,
    sessionShutdown(ctx: ExtensionContext): void {
      if (ctx.mode === "tui") {
        clearPipkinStatus(ctx.ui, PAPERCUT_STATUS.id, PAPERCUT_STATUS.priority);
      }
    },
  };
}
