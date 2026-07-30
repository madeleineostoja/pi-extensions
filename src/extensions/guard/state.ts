import type { FixedCapabilities } from "./capabilities.js";
import type { NonoHealth } from "./runtime/nono.js";

export type GuardRuntimeState = {
  boundaryEnabled: () => boolean;
  generation: () => number;
  semanticConfirmationEnabled: () => boolean;
  backendHealth: () => NonoHealth | undefined;
  fixedCapabilities: () => FixedCapabilities | undefined;
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

  return {
    boundaryEnabled: () => boundary,
    backendHealth: () => health,
    generation: () => generation,
    fixedCapabilities: () => fixed,
    semanticConfirmationEnabled: () => semanticConfirmation,
    resetSession() {
      generation += 1;
      boundary = true;
      semanticConfirmation = true;
      fixed = undefined;
      health = undefined;
    },
    setBoundaryEnabled(enabled) {
      if (boundary !== enabled) {
        boundary = enabled;
        generation += 1;
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
