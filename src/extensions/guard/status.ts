import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuardRuntimeState } from "./state.js";

const STATUS_KEY = "pipkin.guard";
const SANDBOX_ICON = "󰒃";

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
  const warning = status !== "guard";
  const theme = ctx.ui.theme;
  ctx.ui.setStatus(
    STATUS_KEY,
    `${theme.fg(warning ? "warning" : "success", SANDBOX_ICON)} ${theme.fg(warning ? "warning" : "muted", status)}`,
  );
}

export function clearGuardStatus(ctx: ExtensionContext): void {
  if (ctx.mode === "tui") {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}
