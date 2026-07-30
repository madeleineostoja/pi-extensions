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

import {
  createBashToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { promptForPermission } from "#lib/permission-prompt";
import { createFixedCapabilities } from "./capabilities.js";
import { registerGuardCommand } from "./command.js";
import { isSupportedMac } from "./enforcement/decide.js";
import {
  filesystemPromptDetail,
  gateDirectFilesystemTool,
  isDirectFilesystemTool,
} from "./enforcement/tool-gate.js";
import { createGuardBashRuntime } from "./runtime/bash.js";
import { getNonoHealth, type NonoHealth } from "./runtime/nono.js";
import { confirmBashCommand } from "./semantic/confirmation.js";
import { createGuardRuntimeState } from "./state.js";
import { clearGuardStatus, syncGuardStatus } from "./status.js";

function guardExtension(pi: ExtensionAPI): void {
  const state = createGuardRuntimeState();
  const supportedMac = isSupportedMac();
  const bash = createGuardBashRuntime({ state, supportedMac });
  let probeAbort: AbortController | undefined;
  let probe: Promise<void> | undefined;
  let toolsOnlyWarningShown = false;

  registerGuardCommand({ pi, state, supportedMac });

  const registerBash = () => {
    const fixed = state.fixedCapabilities();
    if (!fixed) {
      return;
    }
    const definition = createBashToolDefinition(fixed.cwd, {
      operations: bash.agentOperations,
    });
    pi.registerTool({
      ...definition,
      async execute(toolCallId, input, signal, onUpdate, executionCtx) {
        await confirmBashCommand({
          command: input.command,
          cwd: fixed.cwd,
          state,
          ctx: executionCtx,
        });
        return definition.execute(
          toolCallId,
          input,
          signal,
          onUpdate,
          executionCtx,
        );
      },
    });
  };

  const syncSurface = (ctx: ExtensionContext) => {
    syncGuardStatus(ctx, state, supportedMac);
    if (
      supportedMac &&
      state.boundaryEnabled() &&
      state.backendHealth()?.kind === "tools-only" &&
      ctx.hasUI &&
      !toolsOnlyWarningShown
    ) {
      toolsOnlyWarningShown = true;
      ctx.ui.notify(
        "Guard: Nono is unavailable, so agent Bash is blocked. Trusted ! and !! Bash run locally until you recover Nono and reload Pi.",
        "warning",
      );
    }
  };

  pi.on(
    "session_start",
    async (_event: SessionStartEvent, ctx: ExtensionContext) => {
      state.resetSession();
      probeAbort?.abort();
      const previousProbe = probe;
      const controller = new AbortController();
      probeAbort = controller;
      await previousProbe;
      if (probeAbort !== controller) {
        return;
      }
      state.setFixedCapabilities(
        createFixedCapabilities(ctx.cwd, ctx.sessionManager.getSessionFile()),
      );
      registerBash();
      if (!supportedMac) {
        syncSurface(ctx);
        return;
      }
      const runningProbe = (async () => {
        let health: NonoHealth | undefined;
        try {
          health = await getNonoHealth({ signal: controller.signal });
        } catch {
          health = { kind: "tools-only", reason: "probe-failed" } as const;
        }
        if (probeAbort === controller) {
          state.setBackendHealth(health);
          syncSurface(ctx);
        }
      })();
      probe = runningProbe;
      await runningProbe;
      if (probe === runningProbe) {
        probe = undefined;
      }
    },
  );
  pi.on("session_shutdown", async (_event, ctx) => {
    state.resetSession();
    probeAbort?.abort();
    probeAbort = undefined;
    bash.dispose();
    clearGuardStatus(ctx);
    await probe;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isDirectFilesystemTool(event.toolName)) {
      return undefined;
    }
    const result = await gateDirectFilesystemTool({
      tool: event.toolName,
      input: event.input as { path?: unknown },
      cwd: state.fixedCapabilities()?.cwd ?? ctx.cwd,
      supportedMac,
      canPrompt: ctx.hasUI,
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

  pi.on("user_bash", (_event, ctx) => {
    if (
      supportedMac &&
      state.boundaryEnabled() &&
      state.backendHealth()?.kind === "tools-only" &&
      ctx.hasUI &&
      !toolsOnlyWarningShown
    ) {
      toolsOnlyWarningShown = true;
      ctx.ui.notify(
        "Guard: agent Bash is blocked while Nono is unavailable. Trusted ! and !! Bash run locally.",
        "warning",
      );
    }
    return { operations: bash.userOperations };
  });
}

export default guardExtension;
