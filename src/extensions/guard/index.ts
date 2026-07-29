export {
  canonicalizeTarget,
  createFilesystemGrant,
  createFixedCapabilities,
  grantMatches,
  hasGrant,
  type AccessMode,
  type FilesystemGrant,
  type FixedCapabilities,
  type GrantEffect,
  type GrantKind,
} from "./capabilities.js";
export { isProtectedReadTarget } from "./protected.js";
export { createGuardRuntimeState, type GuardRuntimeState } from "./state.js";
export {
  buildNonoManifest,
  runNono,
  writeNonoManifest,
  type NonoManifest,
  type NonoManifestFile,
} from "./runtime/manifest.js";
export {
  getNonoHealth,
  getNonoTarget,
  managedNonoPath,
  nonoRecoveryMessage,
  NONO_VERSION,
  type NonoHealth,
} from "./runtime/nono.js";

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { createFixedCapabilities } from "./capabilities.js";
import { createGuardRuntimeState } from "./state.js";

function guardExtension(pi: ExtensionAPI): void {
  const state = createGuardRuntimeState();
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    state.resetSession();
    state.setFixedCapabilities(
      createFixedCapabilities(ctx.cwd, ctx.sessionManager.getSessionFile()),
    );
  });
  pi.on("tool_call", () => undefined);
}

export default guardExtension;
