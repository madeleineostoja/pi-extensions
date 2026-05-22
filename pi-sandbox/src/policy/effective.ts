import type { Policy } from "./defaults.js";
import type { SessionState } from "../slash/commands.js";

export function applySessionOverrides(policy: Policy, session: SessionState): Policy {
  if (session.sandboxOff) {
    return { ...policy, enabled: false };
  }

  const networkMode = session.networkOff ? "off" : policy.network.mode;

  const sessionHosts = [...session.sessionAllowedHosts];
  const mergedAllow =
    sessionHosts.length === 0
      ? policy.network.allow
      : [...new Set([...policy.network.allow, ...sessionHosts])];

  return {
    ...policy,
    network: {
      ...policy.network,
      mode: networkMode,
      allow: mergedAllow,
    },
  };
}
