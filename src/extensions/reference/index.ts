import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerDocs } from "./docs-tool.js";

export default function (pi: ExtensionAPI): void {
  registerDocs(pi, getAgentDir);
}
