export {
  canonicalizeTarget,
  createFilesystemGrant,
  resolvePiToolPath,
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
  decideDirectFilesystemTool,
  isSupportedMac,
  prepareExplicitFilesystemGrant,
  type DirectFilesystemDecision,
  type DirectFilesystemTool,
} from "./enforcement/decide.js";
export {
  filesystemPromptDetail,
  filesystemScope,
  gateDirectFilesystemTool,
  isDirectFilesystemTool,
  type FilesystemPromptChoice,
} from "./enforcement/tool-gate.js";
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
import { promptForPermission } from "#lib/permission-prompt";
import { createFixedCapabilities } from "./capabilities.js";
import { isSupportedMac } from "./enforcement/decide.js";
import {
  filesystemPromptDetail,
  gateDirectFilesystemTool,
  isDirectFilesystemTool,
} from "./enforcement/tool-gate.js";
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

  pi.on("tool_call", async (event, ctx) => {
    if (!isDirectFilesystemTool(event.toolName)) {
      return undefined;
    }
    const result = await gateDirectFilesystemTool({
      tool: event.toolName,
      input: event.input as { path?: unknown },
      cwd: ctx.cwd,
      supportedMac: isSupportedMac(),
      canPrompt: ctx.mode === "tui" && ctx.hasUI,
      signal: ctx.signal,
      state,
      prompt: async (request) => {
        const permission = await promptForPermission({
          ui: ctx.ui,
          signal: ctx.signal,
          title: `Guard: allow ${request.grant.access} access?`,
          detail: filesystemPromptDetail(request),
          choices: [
            { value: "once", label: "Allow once" },
            { value: "similar", label: "Allow similar this session" },
            { value: "block", label: "Block" },
          ],
        });
        return permission.kind === "selected" ? permission.value : "block";
      },
    });
    return result.block ? result : undefined;
  });
}

export default guardExtension;
