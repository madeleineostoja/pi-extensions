import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ProcessSessionLifecycle } from "./lifecycle.js";
import { registerProcessTools } from "./tools.js";

export default function (pi: ExtensionAPI): void {
  const lifecycle = new ProcessSessionLifecycle(pi);
  registerProcessTools(pi, () => lifecycle.runtime());
  pi.on("session_start", (event, ctx) => lifecycle.sessionStart(event, ctx));
  pi.on("session_shutdown", () => lifecycle.sessionShutdown());
}
