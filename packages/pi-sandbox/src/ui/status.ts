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
}

export function subscribeStatus(opts: StatusSubscribeOptions): () => void {
  const {
    policyManager,
    getSessionState,
    hasUI,
    ui,
    onSessionMutation,
    inProcessOnly,
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

  function update(): void {
    ui.setStatus("sandbox", renderStatus(buildState()));
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
