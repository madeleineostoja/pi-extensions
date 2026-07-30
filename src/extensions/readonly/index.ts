import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadonlyMode } from "./mode.js";

export default function (pi: ExtensionAPI): void {
  registerReadonlyMode(pi);
}
