import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { promptForAction } from "#lib/action-prompt";
import type { SandboxSessionState } from "./state.js";
import {
  sandboxStatus,
  sandboxStatusLabel,
  syncSandboxStatus,
} from "./status.js";

function panelDetail(
  state: SandboxSessionState,
  supportedMac: boolean,
): string {
  const status = sandboxStatus(state, supportedMac);
  const lines = [`State: ${status.charAt(0).toUpperCase()}${status.slice(1)}`];
  const policy = state.policy();
  if (policy) {
    lines.push(`Workspace: ${policy.workspaceRoot}`);
    const additional = policy.writableRoots.filter(
      (root) => root !== policy.workspaceRoot,
    );
    if (additional.length) {
      lines.push(
        "Additional writable roots:",
        ...additional.map((root) => `  ${root}`),
      );
    }
  }
  if (!supportedMac || !state.policy()) {
    lines.push(
      supportedMac
        ? `${state.unavailableReason() ?? "Sandbox initialization failed."} Reload to retry.`
        : "Sandbox is available only on macOS.",
    );
  }
  return lines.join("\n");
}

function setMode(
  enabled: boolean,
  ctx: ExtensionCommandContext,
  state: SandboxSessionState,
  supportedMac: boolean,
): void {
  if (enabled && (!supportedMac || !state.policy())) {
    ctx.ui.notify(
      !supportedMac
        ? "sandbox: unavailable on this platform"
        : "sandbox: unavailable; reload to retry initialization",
      "warning",
    );
    return;
  }
  if (!enabled && !supportedMac) {
    ctx.ui.notify("sandbox: unavailable on this platform", "warning");
    return;
  }
  state.setEnabled(enabled);
  syncSandboxStatus(ctx, state, supportedMac);
  ctx.ui.notify(`sandbox: ${enabled ? "on" : "off"}`, "info");
}

export function registerSandboxCommand(options: {
  pi: ExtensionAPI;
  state: SandboxSessionState;
  supportedMac: boolean;
}): void {
  options.pi.registerCommand("sandbox", {
    description: "Configure repository-write Sandbox",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "on" || action === "off") {
        setMode(action === "on", ctx, options.state, options.supportedMac);
        return;
      }
      if (action) {
        ctx.ui.notify("usage: /sandbox [on|off]", "warning");
        return;
      }
      if (!ctx.hasUI) {
        return;
      }
      for (;;) {
        const status = sandboxStatus(options.state, options.supportedMac);
        const choices = [
          ...(options.supportedMac
            ? [
                {
                  value: status === "off" ? "on" : "off",
                  label: status === "off" ? "Turn on" : "Turn off",
                },
              ]
            : []),
          { value: "close", label: "Close" },
        ] as const;
        const selected = await promptForAction({
          ui: ctx.ui,
          title: `Sandbox: ${sandboxStatusLabel(status)}`,
          detail: panelDetail(options.state, options.supportedMac),
          choices,
        });
        if (selected.kind === "aborted" || selected.value === "close") {
          return;
        }
        setMode(
          selected.value === "on",
          ctx,
          options.state,
          options.supportedMac,
        );
      }
    },
  });
}

export { panelDetail as sandboxPanelDetail };
