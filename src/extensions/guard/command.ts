import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  managedNonoPath,
  NONO_VERSION,
  nonoRecoveryMessage,
} from "./runtime/nono.js";
import type { GuardRuntimeState } from "./state.js";
import { guardStatus, syncGuardStatus } from "./status.js";

export function guardMenuDetail(
  state: GuardRuntimeState,
  supportedMac: boolean,
): string {
  if (!supportedMac) {
    return "Guard uses local Bash here because its sandbox supports only macOS arm64 and x64.";
  }

  const location = managedNonoPath() ?? "the managed Nono location";
  const health = state.backendHealth();
  return health?.kind === "healthy"
    ? `Managed Nono ${NONO_VERSION} at ${health.path}: healthy.`
    : health?.kind === "tools-only"
      ? `Managed Nono ${NONO_VERSION} at ${location}: unhealthy. ${nonoRecoveryMessage(health)}`
      : `Managed Nono ${NONO_VERSION} at ${location}: checking health.`;
}

export function registerGuardCommand(options: {
  pi: ExtensionAPI;
  state: GuardRuntimeState;
  supportedMac: boolean;
}): void {
  options.pi.registerCommand("guard", {
    description: "Configure Guard sandbox and semantic checks",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        return;
      }
      for (;;) {
        const choices = [
          ...(options.supportedMac
            ? [options.state.boundaryEnabled() ? "Sandbox on" : "Sandbox off"]
            : []),
          options.state.semanticConfirmationEnabled()
            ? "Semantic guard on"
            : "Semantic guard off",
          "Close",
        ];
        const selected = await ctx.ui.select(
          `Guard: ${guardStatus(options.state, options.supportedMac)}\n${guardMenuDetail(options.state, options.supportedMac)}`,
          choices,
        );
        if (!selected || selected === "Close") {
          return;
        }
        if (selected === "Sandbox on" || selected === "Sandbox off") {
          options.state.setBoundaryEnabled(!options.state.boundaryEnabled());
          syncGuardStatus(ctx, options.state, options.supportedMac);
        } else if (
          selected === "Semantic guard on" ||
          selected === "Semantic guard off"
        ) {
          options.state.setSemanticConfirmationEnabled(
            !options.state.semanticConfirmationEnabled(),
          );
        }
      }
    },
  });
}
