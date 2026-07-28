import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { EpochData } from "./policy.ts";

type MutableSessionManager = {
  fileEntries?: unknown[];
  byId?: Map<string, unknown>;
  leafId?: string | null;
  getLeafId(): string | null;
};

export function appendEpochAtomically(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  customType: string,
  data: EpochData,
): void {
  const manager = ctx.sessionManager as unknown as MutableSessionManager;
  const entries = manager.fileEntries?.slice();
  const byId = manager.byId ? new Map(manager.byId) : undefined;
  const leafId = manager.getLeafId();

  try {
    pi.appendEntry(customType, data);
  } catch (error) {
    if (entries && byId && manager.fileEntries && manager.byId) {
      manager.fileEntries.splice(0, manager.fileEntries.length, ...entries);
      manager.byId.clear();
      for (const [id, entry] of byId) {
        manager.byId.set(id, entry);
      }
      manager.leafId = leafId;
    }
    throw error;
  }
}
