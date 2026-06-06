import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { UsageSnapshot } from "../provider.js";

export async function getUsage(
  _model: Model<Api>,
  _ctx: ExtensionContext,
  _force = false,
): Promise<UsageSnapshot | null> {
  return {
    provider: "opencode",
    fetchedAt: Date.now(),
    error:
      "Opencode credentials not configured. Run /usage auth to set them up.",
  };
}
