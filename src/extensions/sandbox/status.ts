import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxSessionState } from "./state.js";

const STATUS_KEY = "pipkin.sandbox";
const SANDBOX_ICON = "󰒃";

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
  const tone = status === "on" ? "success" : "warning";
  const theme = ctx.ui.theme;
  ctx.ui.setStatus(
    STATUS_KEY,
    `${theme.fg(tone, SANDBOX_ICON)} ${theme.fg(tone, sandboxStatusLabel(status))}`,
  );
}

export function clearSandboxStatus(ctx: ExtensionContext): void {
  if (ctx.mode === "tui") {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}
