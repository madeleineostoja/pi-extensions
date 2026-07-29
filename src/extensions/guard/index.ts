export {
  canonicalizeTarget,
  createFilesystemGrant,
  createFixedCapabilities,
  grantMatches,
  hasGrant,
  type AccessMode,
  type FilesystemGrant,
  type FixedCapabilities,
  type GrantEffect,
  type GrantKind,
} from "./capabilities.js";
export { isProtectedReadTarget } from "./protected.js";
export { createGuardRuntimeState, type GuardRuntimeState } from "./state.js";
export {
  buildNonoManifest,
  runNono,
  writeNonoManifest,
  type NonoManifest,
  type NonoManifestFile,
} from "./runtime/manifest.js";
export {
  getNonoHealth,
  getNonoTarget,
  managedNonoPath,
  nonoRecoveryMessage,
  NONO_VERSION,
  type NonoHealth,
} from "./runtime/nono.js";

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { createFixedCapabilities } from "./capabilities.js";
import { getNonoHealth, type NonoHealth } from "./runtime/nono.js";
import { createGuardRuntimeState } from "./state.js";

function guardExtension(pi: ExtensionAPI): void {
  const state = createGuardRuntimeState();
  let probeAbort: AbortController | undefined;
  let probe: Promise<void> | undefined;
  pi.on(
    "session_start",
    async (_event: SessionStartEvent, ctx: ExtensionContext) => {
      probeAbort?.abort();
      const previousProbe = probe;
      const controller = new AbortController();
      probeAbort = controller;
      await previousProbe;
      if (probeAbort !== controller) {
        return;
      }
      state.resetSession();
      state.setFixedCapabilities(
        createFixedCapabilities(ctx.cwd, ctx.sessionManager.getSessionFile()),
      );
      const runningProbe = (async () => {
        let health: NonoHealth | undefined;
        try {
          health = await getNonoHealth({ signal: controller.signal });
        } catch {
          health = { kind: "tools-only", reason: "probe-failed" } as const;
        }
        if (probeAbort === controller) {
          state.setBackendHealth(health);
        }
      })();
      probe = runningProbe;
      await runningProbe;
      if (probe === runningProbe) {
        probe = undefined;
      }
    },
  );
  pi.on("session_shutdown", async () => {
    probeAbort?.abort();
    probeAbort = undefined;
    await probe;
    state.resetSession();
  });
  pi.on("tool_call", () => undefined);
}

export default guardExtension;
