import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { createFixedCapabilities } from "../capabilities.js";
import type { GuardRuntimeState } from "../state.js";
import { clearGuardStatus, syncGuardStatus } from "../status.js";
import type { GuardBashRuntime } from "./bash.js";
import { getNonoHealth, type NonoHealth } from "./nono.js";
import { confirmBashCommand } from "../semantic/confirmation.js";

export function createGuardBashTool(
  state: GuardRuntimeState,
  bash: GuardBashRuntime,
  beforeExecute: () => Promise<void> = async () => undefined,
) {
  const fixed = state.fixedCapabilities();
  if (!fixed) {
    return undefined;
  }
  const definition = createBashToolDefinition(fixed.cwd, {
    operations: bash.agentOperations,
  });
  return {
    ...definition,
    async execute(...args: Parameters<typeof definition.execute>) {
      const [toolCallId, input, signal, onUpdate, executionCtx] = args;
      await beforeExecute();
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
  };
}

export function createGuardSessionController({
  state,
  bash,
  supportedMac,
}: {
  state: GuardRuntimeState;
  bash: GuardBashRuntime;
  supportedMac: boolean;
}) {
  let probeAbort: AbortController | undefined;
  let probe: Promise<void> | undefined;
  let toolsOnlyWarningShown = false;

  const syncSurface = (ctx: ExtensionContext): void => {
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

  return {
    sessionStart(event: SessionStartEvent, ctx: ExtensionContext) {
      state.resetSession();
      probeAbort?.abort();
      const previousProbe = probe;
      const controller = new AbortController();
      probeAbort = controller;
      state.setFixedCapabilities(createFixedCapabilities(ctx.cwd));
      if (!supportedMac) {
        syncSurface(ctx);
        return { bashTool: createGuardBashTool(state, bash) };
      }
      const runningProbe = (async () => {
        await previousProbe;
        if (probeAbort !== controller) {
          return;
        }
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
      const clearProbe = () => {
        if (probe === runningProbe) {
          probe = undefined;
        }
      };
      void runningProbe.then(clearProbe, clearProbe);
      return {
        bashTool: createGuardBashTool(state, bash, () => runningProbe),
      };
    },
    async sessionShutdown(ctx: ExtensionContext): Promise<void> {
      state.resetSession();
      probeAbort?.abort();
      probeAbort = undefined;
      await bash.dispose();
      clearGuardStatus(ctx);
      await probe;
    },
    userBash(ctx: ExtensionContext) {
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
    },
  };
}
