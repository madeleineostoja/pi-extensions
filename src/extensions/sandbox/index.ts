import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSandboxCommand } from "./command.js";
import { createSandboxDenialRecorder } from "./denials.js";
import { createSandboxSessionController } from "./lifecycle.js";
import { createSandboxSessionState } from "./state.js";
import { createSandboxToolGate } from "./tool-gate.js";

export default function (pi: ExtensionAPI): void {
  const supportedMac = process.platform === "darwin";
  const state = createSandboxSessionState();
  const denials = createSandboxDenialRecorder();
  const session = createSandboxSessionController({
    state,
    denials,
    supportedMac,
  });

  registerSandboxCommand({ pi, state, supportedMac });
  pi.on("session_start", async (event, ctx) => {
    pi.registerTool(await session.sessionStart(event, ctx));
  });
  pi.on("session_shutdown", (_event, ctx) => session.sessionShutdown(ctx));
  pi.on("tool_call", createSandboxToolGate({ state, denials, supportedMac }));
}
