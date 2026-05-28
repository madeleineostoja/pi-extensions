import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export { buildHeaders } from "./auth.js";
export { fetchUsage, getUsage, isCodexProvider } from "./usage.js";
export type { UsageSnapshot } from "./usage.js";
export {
  STATUS_KEY,
  CODEX_USAGE_URL,
  CACHE_TTL_MS,
  TIMEOUT_MS,
  ICON,
} from "./constants.js";

export default function (pi: ExtensionAPI) {
  void pi;
}
