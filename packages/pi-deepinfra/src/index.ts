import type {
  ExtensionAPI,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { OVERFLOW_RE, mapModel, shouldIncludeModel } from "./mapping.ts";
import type { DeepInfraModelsResponse } from "./mapping.ts";

const DEEPINFRA_MODELS_URL = "https://api.deepinfra.com/v1/models";
const FETCH_TIMEOUT_MS = 10_000;

const PROVIDER_BASE = {
  name: "DeepInfra",
  baseUrl: "https://api.deepinfra.com/v1/openai",
  apiKey: "DEEPINFRA_API_KEY",
  api: "openai-completions",
} as const;

async function fetchModels(): Promise<ProviderModelConfig[]> {
  const res = await fetch(DEEPINFRA_MODELS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const payload = (await res.json()) as DeepInfraModelsResponse;
  if (!Array.isArray(payload?.data))
    throw new Error("unexpected response shape");

  return payload.data.filter(shouldIncludeModel).map(mapModel);
}

export default function (pi: ExtensionAPI) {
  fetchModels().then(
    (models) => pi.registerProvider("deepinfra", { ...PROVIDER_BASE, models }),
    (err) => {
      process.stderr.write(
        `[pi-deepinfra] Failed to fetch DeepInfra model list: ${err}. No DeepInfra models will be available.\n`,
      );
      pi.registerProvider("deepinfra", { ...PROVIDER_BASE, models: [] });
    },
  );

  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    if (msg.stopReason !== "error") return;
    if (msg.provider !== "deepinfra") return;

    const err = msg.errorMessage ?? "";
    if (err.includes("context_length_exceeded")) return;
    if (!OVERFLOW_RE.test(err)) return;

    return {
      message: { ...msg, errorMessage: `context_length_exceeded: ${err}` },
    };
  });
}
