import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearPipkinStatus, setPipkinStatus } from "#ui/status";
import type { SandboxSessionState } from "./state.js";

const SANDBOX_STATUS = { id: "sandbox", priority: 100, icon: "󰒃" } as const;

export type SandboxStatus = "on" | "off" | "unavailable";

export function sandboxStatus(
  state: SandboxSessionState,
  supportedMac: boolean,
): SandboxStatus {
  if (!supportedMac) {
    return "unavailable";
  }
  if (!state.enabled()) {
    return "off";
  }
  return state.policy() ? "on" : "unavailable";
}

export function sandboxStatusLabel(status: SandboxStatus): string {
  return {
    on: "sandbox",
    off: "sandbox off",
    unavailable: "sandbox unavailable",
  }[status];
}

export function syncSandboxStatus(
  ctx: ExtensionContext,
  state: SandboxSessionState,
  supportedMac: boolean,
): void {
  if (ctx.mode !== "tui") {
    return;
  }
  const status = sandboxStatus(state, supportedMac);
  setPipkinStatus(ctx.ui, {
    ...SANDBOX_STATUS,
    state: status === "on" ? "normal" : "warning",
    text: sandboxStatusLabel(status),
  });
}

export function clearSandboxStatus(ctx: ExtensionContext): void {
  if (ctx.mode === "tui") {
    clearPipkinStatus(ctx.ui, SANDBOX_STATUS.id, SANDBOX_STATUS.priority);
  }
}
