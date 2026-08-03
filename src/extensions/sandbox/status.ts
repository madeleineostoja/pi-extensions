import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearPipkinStatus, setPipkinStatus } from "#ui/status";
import type { SandboxDenialRecorder } from "./denials.js";
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

export function sandboxStatusLabel(status: SandboxStatus, denials = 0): string {
  const label = {
    on: "sandbox",
    off: "sandbox off",
    unavailable: "sandbox unavailable",
  }[status];
  return denials > 0 ? `${label} · ${denials} denied` : label;
}

export function syncSandboxStatus(
  ctx: ExtensionContext,
  state: SandboxSessionState,
  supportedMac: boolean,
  denials?: SandboxDenialRecorder,
): void {
  if (ctx.mode !== "tui") {
    return;
  }
  const status = sandboxStatus(state, supportedMac);
  const count = denials?.snapshot().count ?? 0;
  setPipkinStatus(ctx.ui, {
    ...SANDBOX_STATUS,
    state: status === "on" && count === 0 ? "normal" : "warning",
    text: sandboxStatusLabel(status, count),
  });
}

export function clearSandboxStatus(ctx: ExtensionContext): void {
  if (ctx.mode === "tui") {
    clearPipkinStatus(ctx.ui, SANDBOX_STATUS.id, SANDBOX_STATUS.priority);
  }
}
