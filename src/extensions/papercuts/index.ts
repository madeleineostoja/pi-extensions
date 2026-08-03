import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPapercutsBrowser } from "./browser.js";
import { registerRecordTool } from "./record-tool.js";
import { createPapercutStatusController } from "./status.js";

export default function (pi: ExtensionAPI): void {
  const status = createPapercutStatusController();
  registerRecordTool(pi, status);
  registerPapercutsBrowser(pi, status);
  pi.on("session_start", (_event, ctx) => status.sessionStart(ctx));
  pi.on("session_shutdown", (_event, ctx) => status.sessionShutdown(ctx));
}
