export type { UsageSnapshot } from "./provider.js";
export { getUsage, providerForModel } from "./provider.js";

export function isCodexProvider(provider: string | undefined): boolean {
  if (!provider) {
    return false;
  }
  return provider === "openai-codex" || provider.startsWith("openai-codex-");
}
