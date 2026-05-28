import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerImplementCommand } from "./command.js";

export default function (pi: ExtensionAPI) {
  registerImplementCommand(pi);
}
