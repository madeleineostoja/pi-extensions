import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
      return { block: true, reason: unavailableReason(options.state) };
    }
    const decision = decideDirectMutation({
      tool: event.toolName,
      input: (event.input ?? {}) as { path?: unknown },
      policy,
    });
    if (decision.kind === "allow") {
      return undefined;
    }
    return {
      block: true,
      reason: decision.target
        ? `${decision.reason} Effective target: ${decision.target}`
        : decision.reason,
    };
  };
}
