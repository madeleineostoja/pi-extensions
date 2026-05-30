export type {
  SandboxAuditEvent,
  SandboxPolicyChangedEvent,
  AuditEntry,
} from "./audit/schema.js";
export { createAuditPipeline } from "./audit/audit.js";
export type { RecordAuditOptions, AuditPipeline } from "./audit/audit.js";

export { createCaps } from "./enforcement/caps.js";
export type {
  CapabilityManifest,
  CapabilitySet,
  ManifestContext,
  NonoFilesystem,
  NonoFilesystemDeny,
  NonoNetwork,
  CapsInstance,
} from "./enforcement/caps.js";

export {
  getNonoPath,
  getBinaryStatus,
  isSupportedPlatform,
  detectMusl,
  checkNonoVersion,
  pinnedVersion,
} from "./runtime/binary.js";
export type { BinaryStatus } from "./runtime/binary.js";

export {
  parseArgs,
  getArgumentCompletions,
  createSlashCommands,
  isValidHost,
  writeHostsToPersisted,
  removeHostFromPersistedFile,
} from "./slash/commands.js";
export type {
  SessionState,
  SubcommandContext,
  ParsedArgs,
  SlashCommandsInstance,
} from "./slash/commands.js";

export { applySessionOverrides } from "./policy/effective.js";

export { createToolGate, BLOCK_REASON } from "./enforcement/toolGate.js";
export type {
  ToolCallEvent,
  ToolGate,
  ToolGateOptions,
  ToolGateResult,
  AccessMode,
} from "./enforcement/toolGate.js";

export { sandboxExtension };
export default sandboxExtension;

import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  SessionShutdownEvent,
  UserBashEvent,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { createPolicyManager } from "./policy/load.js";
import { createSlashCommands } from "./slash/commands.js";
import { createToolGate } from "./enforcement/toolGate.js";
import { initSubprocessSandbox } from "./enforcement/subprocess.js";
import { getNonoPath, getBinaryStatus } from "./runtime/binary.js";
import { subscribeStatus } from "./ui/status.js";
import { createAuditPipeline } from "./audit/audit.js";
import type { AuditEntry } from "./audit/schema.js";
import type { ManifestContext } from "./enforcement/caps.js";

const MESSAGE_TYPE = "pi-sandbox.status";

type StatusDetails = {
  message: string;
};

const renderStatusMessage: MessageRenderer<StatusDetails> = (
  message,
  _options,
  theme,
) => {
  const text = message.details?.message ?? String(message.content);
  return {
    render: () => [theme.fg("dim", text)],
    invalidate: () => {},
  };
};

// Process-wide guard: prevents double-registration on the same pi object.
// A WeakSet is appropriate because instances are owned by the caller and
// we must not extend their lifetime.
const _registered = new WeakSet<ExtensionAPI>();

/**
 * Wire the sandbox extension into a Pi instance.
 *
 * Conforms to `ExtensionFactory = (pi: ExtensionAPI) => void`. Initialization
 * that requires an `ExtensionContext` (cwd, ui, hasUI) runs inside the
 * `session_start` handler, where Pi provides `ctx` as the second argument.
 *
 * Safe to load multiple times: a second `session_start` on the same `pi`
 * instance is a no-op with a warning emitted via `ctx.ui.notify`.
 */
function sandboxExtension(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(MESSAGE_TYPE, renderStatusMessage);

  function sendStatusMessage(message: string): void {
    pi.sendMessage({
      customType: MESSAGE_TYPE,
      content: message,
      display: true,
      details: { message },
    });
  }

  pi.on(
    "session_start",
    (_event: SessionStartEvent, ctx: ExtensionContext): void => {
      if (_registered.has(pi)) {
        ctx.ui.notify(
          "pi-sandbox: sandboxExtension called twice on the same pi instance — ignoring.",
          "warning",
        );
        return;
      }
      _registered.add(pi);

      const policyManager = createPolicyManager();

      try {
        policyManager.loadPolicy(ctx.cwd, { ui: ctx.ui });
      } catch (err) {
        ctx.ui.notify(
          `pi-sandbox: failed to load policy: ${String(err)}`,
          "error",
        );
      }

      const manifestCtx: ManifestContext = {
        hasUI: ctx.hasUI,
        cwd: ctx.cwd,
        platform: process.platform,
        ui: {
          notify: (text: string, level: "warning" | "error") =>
            ctx.ui.notify(text, level),
        },
      };

      const piEventsTarget = {
        emit: (event: string, payload: unknown) =>
          pi.events.emit(event, payload),
      };
      const { recordAudit, getRecentBlockedHosts } = createAuditPipeline();

      function onAudit(entry: Omit<AuditEntry, "ts">): void {
        const policy = policyManager.getPolicy();
        recordAudit(entry, {
          logEnabled: policy.audit.log,
          logFile: policy.audit.logFile,
          events: piEventsTarget,
          onWarning: sendStatusMessage,
        });
      }

      const cmds = createSlashCommands({ recordAudit, getRecentBlockedHosts });

      const nonoPath = getNonoPath();
      const binaryStatus = getBinaryStatus();

      const policy = policyManager.getPolicy();
      if (policy.enforcement.requireKernelSandbox && nonoPath === null) {
        const reasonDetail =
          binaryStatus.kind === "platform-unsupported"
            ? `platform ${binaryStatus.platform} is not supported`
            : binaryStatus.kind === "install-failed"
              ? `install failed (${binaryStatus.reason}${
                  binaryStatus.detail ? `: ${binaryStatus.detail}` : ""
                })`
              : binaryStatus.kind === "ok"
                ? "binary missing despite ok status (state drift)"
                : `unexpected status ${(binaryStatus as { kind: string }).kind}`;
        ctx.ui.notify(
          `pi-sandbox: enforcement.requireKernelSandbox is true but kernel enforcement is unavailable — ${reasonDetail}. ` +
            "Install nono: node packages/pi-sandbox/scripts/postinstall.js (or brew install always-further/tap/nono). " +
            "To run in degraded mode, set enforcement.requireKernelSandbox to false.",
          "error",
        );
        _registered.delete(pi);
        return;
      }

      const { userBashHandler, unwrap: unwrapPiExec } = initSubprocessSandbox(
        pi,
        () => policyManager.getPolicy(),
        manifestCtx,
        () => cmds.getSessionState(),
        nonoPath,
        onAudit,
      );

      const gate = createToolGate({
        getPolicy: () => policyManager.getPolicy(),
        getSession: () => cmds.getSessionState(),
        ctx: manifestCtx,
        onAudit,
      });

      pi.on(
        "tool_call",
        async (event: ToolCallEvent): Promise<ToolCallEventResult | void> => {
          const result = await gate.handleToolCall(event);
          if (result) {
            return { block: true, reason: result.reason };
          }
          return undefined;
        },
      );

      pi.on(
        "user_bash",
        (event: UserBashEvent): UserBashEventResult | undefined =>
          userBashHandler(event),
      );

      if (nonoPath === null) {
        const reasonDetail =
          binaryStatus.kind === "platform-unsupported"
            ? `platform ${binaryStatus.platform} is not supported`
            : binaryStatus.kind === "install-failed"
              ? `install failed (${binaryStatus.reason}${
                  binaryStatus.detail ? `: ${binaryStatus.detail}` : ""
                })`
              : binaryStatus.kind === "ok"
                ? "binary missing despite ok status (state drift)"
                : `unexpected status ${(binaryStatus as { kind: string }).kind}`;
        ctx.ui.notify(
          `pi-sandbox: nono binary unavailable — ${reasonDetail}. ` +
            "Subprocess sandboxing is disabled; bash/exec will be blocked unless degraded.allowExec is true. " +
            "Install nono: node packages/pi-sandbox/scripts/postinstall.js (or brew install always-further/tap/nono).",
          "warning",
        );
      }

      cmds.registerSandboxCommand(pi, policyManager, ctx.cwd, piEventsTarget);

      const unsubStatus = subscribeStatus({
        policyManager,
        getSessionState: () => cmds.getSessionState(),
        hasUI: ctx.hasUI,
        ui: { setStatus: (key, text) => ctx.ui.setStatus(key, text) },
        onSessionMutation: (fn: () => void) => {
          return cmds.subscribeSessionChange(fn);
        },
        inProcessOnly: nonoPath === null,
        theme: ctx.hasUI ? ctx.ui.theme : undefined,
      });

      pi.on(
        "session_shutdown",
        (_shutdownEvent: SessionShutdownEvent): void => {
          unsubStatus();
          gate.dispose();
          unwrapPiExec();
          _registered.delete(pi);
        },
      );
    },
  );
}
