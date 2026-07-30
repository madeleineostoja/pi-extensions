import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLsp } from "./tool.js";

export default function (pi: ExtensionAPI): void {
  registerLsp(pi);
}
