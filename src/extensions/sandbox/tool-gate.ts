import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxDenialRecorder } from "./denials.js";
import { decideDirectMutation } from "./direct.js";
import type { SandboxSessionState } from "./state.js";

function unavailableReason(state: SandboxSessionState): string {
  return (
    state.unavailableReason() ??
    "Sandbox: direct mutations are unavailable until Sandbox is turned off."
  );
}

export function createSandboxToolGate(options: {
  state: SandboxSessionState;
  denials: SandboxDenialRecorder;
  supportedMac: boolean;
}) {
  return (
    event: { toolName: string; input: unknown },
    _ctx: ExtensionContext,
  ) => {
    if (
      !options.supportedMac ||
      !options.state.enabled() ||
      (event.toolName !== "write" && event.toolName !== "edit")
    ) {
      return undefined;
    }
    const policy = options.state.policy();
    if (!policy) {
      const reason = unavailableReason(options.state);
      options.denials.recordDirect({
        tool: event.toolName,
        requestedPath:
          typeof (event.input as { path?: unknown } | undefined)?.path ===
          "string"
            ? (event.input as { path: string }).path
            : undefined,
        reason,
      });
      return { block: true, reason };
    }
    const decision = decideDirectMutation({
      tool: event.toolName,
      input: (event.input ?? {}) as { path?: unknown },
      policy,
      writeMode: options.state.writeMode(),
    });
    if (decision.kind === "allow") {
      return undefined;
    }
    options.denials.recordDirect({
      tool: event.toolName,
      requestedPath:
        typeof (event.input as { path?: unknown } | undefined)?.path ===
        "string"
          ? (event.input as { path: string }).path
          : undefined,
      target: decision.target,
      reason: decision.reason,
    });
    return {
      block: true,
      reason: decision.target
        ? `${decision.reason} Effective target: ${decision.target}`
        : decision.reason,
    };
  };
}
