import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerCodeSearch } from "./code-search-tool.js";
import { registerDocs } from "./docs-tool.js";
import { registerPackageSearch } from "./package-search-tool.js";

export default function (pi: ExtensionAPI): void {
  registerDocs(pi, getAgentDir);
  registerPackageSearch(pi, getAgentDir);
  registerCodeSearch(pi, getAgentDir);
}
