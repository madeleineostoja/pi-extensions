import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuardRuntimeState } from "./state.js";

const STATUS_KEY = "pipkin.guard";

export function guardStatus(
  state: GuardRuntimeState,
  supportedMac: boolean,
): "guard" | "guard: tools-only" | "guard: local" {
  if (!supportedMac || !state.boundaryEnabled()) {
    return "guard: local";
  }
  return state.backendHealth()?.kind === "healthy"
    ? "guard"
    : "guard: tools-only";
}

export function syncGuardStatus(
  ctx: ExtensionContext,
  state: GuardRuntimeState,
  supportedMac: boolean,
): void {
  if (ctx.mode !== "tui") {
    return;
  }
  const status = guardStatus(state, supportedMac);
  const color = status === "guard" ? "success" : "warning";
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, status));
}

export function clearGuardStatus(ctx: ExtensionContext): void {
  if (ctx.mode === "tui") {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}
