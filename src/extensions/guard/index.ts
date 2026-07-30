import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardCommand } from "./command.js";
import { isSupportedMac } from "./enforcement/decide.js";
import { createDirectFilesystemToolHandler } from "./enforcement/handler.js";
import { createGuardBashRuntime } from "./runtime/bash.js";
import { createGuardSessionController } from "./runtime/controller.js";
import { createGuardRuntimeState } from "./state.js";

export default function (pi: ExtensionAPI): void {
  const state = createGuardRuntimeState();
  const supportedMac = isSupportedMac();
  const bash = createGuardBashRuntime({ state, supportedMac });
  const session = createGuardSessionController({ state, bash, supportedMac });

  registerGuardCommand({ pi, state, supportedMac });
  pi.on("session_start", (event, ctx) => {
    const { bashTool } = session.sessionStart(event, ctx);
    if (bashTool) {
      pi.registerTool(bashTool);
    }
  });
  pi.on("session_shutdown", (_event, ctx) => session.sessionShutdown(ctx));
  pi.on(
    "tool_call",
    createDirectFilesystemToolHandler({ state, supportedMac }),
  );
  pi.on("user_bash", (_event, ctx) => session.userBash(ctx));
}
