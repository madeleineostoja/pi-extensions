import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBtwCommand } from "./command.js";

export default function (pi: ExtensionAPI): void {
  registerBtwCommand(pi);
}
