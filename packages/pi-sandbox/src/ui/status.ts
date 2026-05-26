import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Policy } from "../policy/defaults.js";
import type { PolicyManager } from "../policy/load.js";
import type { SessionState } from "../slash/commands.js";

// ---------------------------------------------------------------------------
// Status state shape
// ---------------------------------------------------------------------------

export interface StatusState {
  enabled: boolean;
  networkOff: boolean;
  networkMode: Policy["network"]["mode"];
  hasUI: boolean;
  allowedHostCount: number;
  writableRootCount: number;
  inProcessOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Pure renderer
// ---------------------------------------------------------------------------

export function renderStatus(state: StatusState): string {
  if (!state.enabled) {
    return "⚠ sandbox: off";
  }

  if (state.inProcessOnly) {
    return "🔒 sandbox · in-process only";
  }

  if (state.networkOff) {
    return "🔒 sandbox · network: ⚠ off";
  }

  if (state.networkMode === "off") {
    return "🔒 sandbox · network: off (config)";
  }

  if (state.networkMode === "non-interactive-only" && state.hasUI) {
    return "🔒 sandbox · network: off (interactive)";
  }

  return `🔒 sandbox · ${state.allowedHostCount} hosts · ${state.writableRootCount} writable`;
}

export function renderStatusThemed(
  state: StatusState,
  theme: Pick<Theme, "fg">,
): string {
  if (!state.enabled) {
    return `${theme.fg("warning", "󰒃")} ${theme.fg("warning", "sandbox: off")}`;
  }

  if (state.inProcessOnly) {
    return `${theme.fg("warning", "󰒃")} ${theme.fg("muted", "sandbox · in-process only")}`;
  }

  const icon = theme.fg("success", "󰒃");

  if (state.networkOff) {
    return `${icon} ${theme.fg("muted", "sandbox · network:")} ${theme.fg("dim", "off")}`;
  }

  if (state.networkMode === "off") {
    return `${icon} ${theme.fg("muted", "sandbox · network: off (config)")}`;
  }

  if (state.networkMode === "non-interactive-only" && state.hasUI) {
    return `${icon} ${theme.fg("muted", "sandbox · network: off (interactive)")}`;
  }

  return `${icon} ${theme.fg("muted", `sandbox · ${state.allowedHostCount} hosts · ${state.writableRootCount} writable`)}`;
}

// ---------------------------------------------------------------------------
// Glue layer — subscribe-and-update
// ---------------------------------------------------------------------------

export interface StatusUI {
  setStatus: (key: string, text: string | undefined) => void;
}

export interface StatusSubscribeOptions {
  policyManager: PolicyManager;
  getSessionState: () => SessionState;
  hasUI: boolean;
  ui: StatusUI;
  /** Subscribe to session mutation events (sandbox:policy-changed). Returns unsubscribe fn. */
  onSessionMutation: (fn: () => void) => () => void;
  inProcessOnly?: boolean;
  theme?: Pick<Theme, "fg">;
}

export function subscribeStatus(opts: StatusSubscribeOptions): () => void {
  const {
    policyManager,
    getSessionState,
    hasUI,
    ui,
    onSessionMutation,
    inProcessOnly,
    theme,
  } = opts;

  function buildState(): StatusState {
    const policy = policyManager.getPolicy();
    const session = getSessionState();
    return {
      enabled: policy.enabled && !session.sandboxOff,
      networkOff: session.networkOff,
      networkMode: policy.network.mode,
      hasUI,
      allowedHostCount:
        policy.network.allow.length + session.sessionAllowedHosts.size,
      writableRootCount: policy.fs.allowWrite.length,
      inProcessOnly,
    };
  }

  const render = theme
    ? (state: StatusState) => renderStatusThemed(state, theme)
    : renderStatus;

  function update(): void {
    ui.setStatus("sandbox", render(buildState()));
  }

  update();

  const unsubPolicy = policyManager.subscribe(() => update());
  const unsubSession = onSessionMutation(() => update());

  return () => {
    unsubPolicy();
    unsubSession();
    ui.setStatus("sandbox", undefined);
  };
}
