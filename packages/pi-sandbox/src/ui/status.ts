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
  inProcessOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Pure renderer
// ---------------------------------------------------------------------------

function isNetworkSandboxed(state: StatusState): boolean {
  if (state.networkOff) return true;
  if (state.networkMode === "off" || state.networkMode === "always")
    return true;
  return state.networkMode === "non-interactive-only" && !state.hasUI;
}

export function renderStatus(state: StatusState): string {
  if (!state.enabled) return "⚠ sandbox: off";
  if (state.inProcessOnly) return "🔒 sandbox (degraded)";
  if (isNetworkSandboxed(state)) return "🔒 sandbox (network)";
  return "🔒 sandbox";
}

export function renderStatusThemed(
  state: StatusState,
  theme: Pick<Theme, "fg">,
): string {
  if (!state.enabled) {
    return `${theme.fg("warning", "󰒃")} ${theme.fg("warning", "sandbox: off")}`;
  }

  if (state.inProcessOnly) {
    return `${theme.fg("warning", "󰒃")} ${theme.fg("warning", "sandbox (degraded)")}`;
  }

  const icon = theme.fg("success", "󰒃");

  if (isNetworkSandboxed(state)) {
    return `${icon} ${theme.fg("muted", "sandbox (network)")}`;
  }

  return `${icon} ${theme.fg("muted", "sandbox")}`;
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
