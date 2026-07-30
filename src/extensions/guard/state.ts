import {
  type AccessMode,
  type FilesystemGrant,
  type FixedCapabilities,
  hasGrant,
} from "./capabilities.js";
import type { NonoHealth } from "./runtime/nono.js";

export type GuardRuntimeState = {
  boundaryEnabled: () => boolean;
  generation: () => number;
  semanticConfirmationEnabled: () => boolean;
  backendHealth: () => NonoHealth | undefined;
  fixedCapabilities: () => FixedCapabilities | undefined;
  filesystemGrants: () => readonly FilesystemGrant[];
  protectedReadApprovals: () => readonly FilesystemGrant[];
  allowsReachability: (path: string, access: AccessMode) => boolean;
  allowsProtectedRead: (path: string) => boolean;
  addGrant: (grant: FilesystemGrant) => void;
  removeFilesystemGrant: (grant: FilesystemGrant) => void;
  removeProtectedReadApproval: (grant: FilesystemGrant) => void;
  clearFilesystemState: () => void;
  resetSession: () => void;
  setBoundaryEnabled: (enabled: boolean) => void;
  setBackendHealth: (health: NonoHealth | undefined) => void;
  setFixedCapabilities: (capabilities: FixedCapabilities) => void;
  setSemanticConfirmationEnabled: (enabled: boolean) => void;
};

export function createGuardRuntimeState(): GuardRuntimeState {
  let boundary = true;
  let generation = 0;
  let semanticConfirmation = true;
  let fixed: FixedCapabilities | undefined;
  let health: NonoHealth | undefined;
  let reachability: FilesystemGrant[] = [];
  let protectedApprovals: FilesystemGrant[] = [];

  return {
    boundaryEnabled: () => boundary,
    backendHealth: () => health,
    generation: () => generation,
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
    removeFilesystemGrant(grant) {
      reachability = reachability.filter((current) => current !== grant);
    },
    removeProtectedReadApproval(grant) {
      protectedApprovals = protectedApprovals.filter(
        (current) => current !== grant,
      );
    },
    clearFilesystemState() {
      reachability = [];
      protectedApprovals = [];
    },
    resetSession() {
      generation += 1;
      fixed = undefined;
      health = undefined;
      reachability = [];
      protectedApprovals = [];
      semanticConfirmation = true;
    },
    setBoundaryEnabled(enabled) {
      if (boundary !== enabled) {
        boundary = enabled;
        generation += 1;
        reachability = [];
        protectedApprovals = [];
      }
    },
    setBackendHealth(nextHealth) {
      health = nextHealth;
    },
    setFixedCapabilities(capabilities) {
      fixed = capabilities;
    },
    setSemanticConfirmationEnabled(enabled) {
      semanticConfirmation = enabled;
    },
  };
}
