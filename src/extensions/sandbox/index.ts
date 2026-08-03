import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSandboxCommand } from "./command.js";
import { createSandboxDenialRecorder } from "./denials.js";
import { createSandboxSessionController } from "./lifecycle.js";
import { bindSandboxHost, type SandboxHostBinding } from "./runtime.js";
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
    host: pi.events,
  });

  let hostBinding: SandboxHostBinding | undefined;

  registerSandboxCommand({ pi, state, denials, supportedMac });
  pi.on("session_start", async (event, ctx) => {
    hostBinding?.dispose();
    hostBinding = bindSandboxHost(pi.events, state.enabled);
    const started = await session.sessionStart(
      event,
      ctx,
      hostBinding.inheritedEnabled,
    );
    pi.registerTool(started.definition);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const binding = hostBinding;
    hostBinding = undefined;
    try {
      await session.sessionShutdown(ctx);
    } finally {
      binding?.dispose();
    }
  });
  pi.on("tool_call", createSandboxToolGate({ state, denials, supportedMac }));
}
