import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createInhibitor } from "./inhibitor.js";

export default function (pi: ExtensionAPI): void {
  const inhibitor = createInhibitor();
  const onProcessExit = () => inhibitor.stop();

  process.on("exit", onProcessExit);

  pi.on("session_start", (event: { reason?: string } = {}) => {
    inhibitor.start(event.reason);
  });

  pi.on("session_shutdown", () => {
    inhibitor.shutdown();
    process.removeListener("exit", onProcessExit);
  });
}
