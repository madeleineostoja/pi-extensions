import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBtwCommand } from "./command.js";
import { BTW_MESSAGE_TYPE, renderBtwMessage } from "./promotion.js";

export default function (pi: ExtensionAPI): void {
  pi.registerMessageRenderer(BTW_MESSAGE_TYPE, renderBtwMessage);
  registerBtwCommand(pi);
}
