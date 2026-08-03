import type {
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createSandboxBashDefinition,
  createSandboxBashRuntime,
} from "./bash.js";
import { bindSandboxBashExecutor } from "./bash-binding.js";
import type { SandboxBashHost, SandboxBashRequest } from "./bash-capability.js";
import {
  createSandboxDenialObserver,
  type SandboxDenialObserver,
} from "./denial-observer.js";
import type { SandboxDenialRecorder } from "./denials.js";
import { resolveSandboxPolicy } from "./policy.js";
import type { SandboxSessionState } from "./state.js";
import { clearSandboxStatus, syncSandboxStatus } from "./status.js";

function initializationError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const bounded = Array.from(detail, (character) =>
    /\p{C}/u.test(character) ? "�" : character,
  )
    .join("")
    .slice(0, 240);
  return `Sandbox: initialization failed: ${bounded}`;
}

export function createSandboxSessionController(options: {
  state: SandboxSessionState;
  denials: SandboxDenialRecorder;
  supportedMac: boolean;
  host: SandboxBashHost;
  resolvePolicy?: typeof resolveSandboxPolicy;
  createDenialObserver?: (options: {
    denials: SandboxDenialRecorder;
  }) => SandboxDenialObserver;
}) {
  let bash: ReturnType<typeof createSandboxBashRuntime> | undefined;
  let observer: SandboxDenialObserver | undefined;
  let bashBinding: { dispose: () => void } | undefined;
  let unsubscribeDenials: (() => void) | undefined;
  let shutdown: Promise<void> | undefined;

  return {
    async sessionStart(
      _event: SessionStartEvent,
      ctx: ExtensionContext,
      inheritedEnabled?: boolean,
    ) {
      bashBinding?.dispose();
      bashBinding = undefined;
      unsubscribeDenials?.();
      unsubscribeDenials = undefined;
      await shutdown;
      shutdown = undefined;
      const previousBash = bash;
      const previousObserver = observer;
      bash = undefined;
      observer = undefined;
      await previousBash?.dispose();
      await previousObserver?.dispose();
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
      if (inheritedEnabled !== undefined) {
        options.state.setEnabled(inheritedEnabled);
      }
      options.denials.reset();
      if (options.supportedMac) {
        try {
          observer = (
            options.createDenialObserver ?? createSandboxDenialObserver
          )({
            denials: options.denials,
          });
          observer.start();
        } catch {
          observer = undefined;
        }
      }
      bash = createSandboxBashRuntime({
        policy,
        enabled: options.state.enabled,
        supportedMac: options.supportedMac,
        unavailableReason: failure,
        denialObserver: observer,
      });
      syncSandboxStatus(
        ctx,
        options.state,
        options.supportedMac,
        options.denials,
      );
      unsubscribeDenials = options.denials.subscribe(() =>
        syncSandboxStatus(
          ctx,
          options.state,
          options.supportedMac,
          options.denials,
        ),
      );
      const definition = createSandboxBashDefinition(
        policy?.sessionCwd ?? ctx.cwd,
        bash,
      );
      const execute = (request: SandboxBashRequest) =>
        definition.execute(
          request.toolCallId,
          request.params,
          request.signal,
          request.onUpdate,
          request.ctx,
        );
      bashBinding = bindSandboxBashExecutor(options.host, execute);
      return { definition, execute };
    },
    async sessionShutdown(ctx: ExtensionContext): Promise<void> {
      if (!shutdown) {
        const activeBashBinding = bashBinding;
        const activeBash = bash;
        const activeObserver = observer;
        bashBinding = undefined;
        bash = undefined;
        observer = undefined;
        unsubscribeDenials?.();
        unsubscribeDenials = undefined;
        activeBashBinding?.dispose();
        options.state.revoke();
        clearSandboxStatus(ctx);
        shutdown = (async () => {
          await activeBash?.dispose();
          await activeObserver?.dispose();
          options.denials.reset();
        })();
      }
      await shutdown;
    },
  };
}
