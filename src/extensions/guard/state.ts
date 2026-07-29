import {
  type AccessMode,
  type FilesystemGrant,
  type FixedCapabilities,
  hasGrant,
} from "./capabilities.js";

export type GuardRuntimeState = {
  boundaryEnabled: () => boolean;
  semanticConfirmationEnabled: () => boolean;
  fixedCapabilities: () => FixedCapabilities | undefined;
  filesystemGrants: () => readonly FilesystemGrant[];
  protectedReadApprovals: () => readonly FilesystemGrant[];
  allowsReachability: (path: string, access: AccessMode) => boolean;
  allowsProtectedRead: (path: string) => boolean;
  addGrant: (grant: FilesystemGrant) => void;
  clearFilesystemState: () => void;
  resetSession: () => void;
  setBoundaryEnabled: (enabled: boolean) => void;
  setFixedCapabilities: (capabilities: FixedCapabilities) => void;
  setSemanticConfirmationEnabled: (enabled: boolean) => void;
};

export function createGuardRuntimeState(): GuardRuntimeState {
  let boundary = true;
  let semanticConfirmation = true;
  let fixed: FixedCapabilities | undefined;
  let reachability: FilesystemGrant[] = [];
  let protectedApprovals: FilesystemGrant[] = [];

  return {
    boundaryEnabled: () => boundary,
    fixedCapabilities: () => fixed,
    semanticConfirmationEnabled: () => semanticConfirmation,
    filesystemGrants: () => reachability,
    protectedReadApprovals: () => protectedApprovals,
    allowsReachability: (path, access) => hasGrant(reachability, path, access),
    allowsProtectedRead: (path) => hasGrant(protectedApprovals, path, "read"),
    addGrant(grant) {
      if (
        grant.effects.includes("outside-boundary") &&
        !hasGrant(reachability, grant.path, grant.access)
      ) {
        reachability.push(grant);
      }
      if (
        grant.effects.includes("protected-read") &&
        !hasGrant(protectedApprovals, grant.path, "read")
      ) {
        protectedApprovals.push({ ...grant, access: "read" });
      }
    },
    clearFilesystemState() {
      reachability = [];
      protectedApprovals = [];
    },
    resetSession() {
      fixed = undefined;
      reachability = [];
      protectedApprovals = [];
      semanticConfirmation = true;
    },
    setBoundaryEnabled(enabled) {
      if (boundary !== enabled) {
        boundary = enabled;
        reachability = [];
        protectedApprovals = [];
      }
    },
    setFixedCapabilities(capabilities) {
      fixed = capabilities;
    },
    setSemanticConfirmationEnabled(enabled) {
      semanticConfirmation = enabled;
    },
  };
}
