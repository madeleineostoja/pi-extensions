import type { Policy } from "./defaults.js";
import type { SessionState } from "../slash/commands.js";

export function applySessionOverrides(
  policy: Policy,
  session: SessionState,
): Policy {
  if (session.sandboxOff) {
    return { ...policy, enabled: false };
  }

  const networkMode = session.networkOff ? "off" : policy.network.mode;

  const sessionHosts = [...session.sessionAllowedHosts];
  const mergedAllow =
    sessionHosts.length === 0
      ? policy.network.allow
      : [...new Set([...policy.network.allow, ...sessionHosts])];

  const sessionReadPaths = [...session.sessionAllowedReadPaths];
  const sessionWritePaths = [...session.sessionAllowedWritePaths];
  const mergedAllowRead =
    sessionReadPaths.length === 0
      ? policy.fs.allowRead
      : [...new Set([...policy.fs.allowRead, ...sessionReadPaths])];
  const mergedAllowWrite =
    sessionWritePaths.length === 0
      ? policy.fs.allowWrite
      : [...new Set([...policy.fs.allowWrite, ...sessionWritePaths])];

  return {
    ...policy,
    fs:
      sessionReadPaths.length === 0 && sessionWritePaths.length === 0
        ? policy.fs
        : {
            ...policy.fs,
            allowRead: mergedAllowRead,
            allowWrite: mergedAllowWrite,
          },
    network: {
      ...policy.network,
      mode: networkMode,
      allow: mergedAllow,
    },
  };
}
