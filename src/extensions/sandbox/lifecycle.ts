import type {
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createSandboxBashDefinition,
  createSandboxBashRuntime,
} from "./bash.js";
import { resolveSandboxPolicy } from "./policy.js";
import type { SandboxSessionState } from "./state.js";
import { clearSandboxStatus, syncSandboxStatus } from "./status.js";

function initializationError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Sandbox: initialization failed: ${detail.slice(0, 240)}`;
}

export function createSandboxSessionController(options: {
  state: SandboxSessionState;
  supportedMac: boolean;
  resolvePolicy?: typeof resolveSandboxPolicy;
}) {
  let bash: ReturnType<typeof createSandboxBashRuntime> | undefined;
  let shutdown: Promise<void> | undefined;

  return {
    async sessionStart(_event: SessionStartEvent, ctx: ExtensionContext) {
      await shutdown;
      shutdown = undefined;
      let policy;
      let failure: string | undefined;
      if (options.supportedMac) {
        try {
          policy = await (options.resolvePolicy ?? resolveSandboxPolicy)({
            sessionCwd: ctx.cwd,
          });
        } catch (error) {
          failure = initializationError(error);
        }
      }
      options.state.reset(policy, failure);
      bash = createSandboxBashRuntime({
        policy,
        enabled: options.state.enabled,
        supportedMac: options.supportedMac,
        unavailableReason: failure,
      });
      syncSandboxStatus(ctx, options.state, options.supportedMac);
      return createSandboxBashDefinition(policy?.sessionCwd ?? ctx.cwd, bash);
    },
    async sessionShutdown(ctx: ExtensionContext): Promise<void> {
      if (!shutdown) {
        const active = bash;
        bash = undefined;
        options.state.revoke();
        clearSandboxStatus(ctx);
        shutdown = active?.dispose() ?? Promise.resolve();
      }
      await shutdown;
    },
  };
}
