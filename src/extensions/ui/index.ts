import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installFooter } from "./footer.js";

export default function (pi: ExtensionAPI): void {
  installFooter(pi);
}
