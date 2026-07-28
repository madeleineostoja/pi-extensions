import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createFauxCore } from "@earendil-works/pi-ai";

export const MANAGED_TEST_PROVIDER = "managed-completion-test";
export const MANAGED_TEST_MODEL = "managed-completion-model";
export const MANAGED_TEST_CWD = "/managed-completion-workspace";

export type FauxResponse = Parameters<
  ReturnType<typeof createFauxCore>["setResponses"]
>[0];

export async function createManagedSessionHarness(responses: FauxResponse) {
  const faux = createFauxCore({
    provider: MANAGED_TEST_PROVIDER,
    api: "openai-completions",
    models: [{ id: MANAGED_TEST_MODEL }],
  });
  const fauxModel = faux.getModel(MANAGED_TEST_MODEL);
  if (!fauxModel) {
    throw new Error("Missing faux test model.");
  }
  faux.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  modelRuntime.registerProvider(MANAGED_TEST_PROVIDER, {
    api: fauxModel.api,
    baseUrl: fauxModel.baseUrl,
    apiKey: "test-key",
    streamSimple: faux.streamSimple,
    models: [
      {
        id: fauxModel.id,
        name: fauxModel.name,
        api: fauxModel.api,
        baseUrl: fauxModel.baseUrl,
        reasoning: fauxModel.reasoning,
        input: fauxModel.input,
        cost: fauxModel.cost,
        contextWindow: fauxModel.contextWindow,
        maxTokens: fauxModel.maxTokens,
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey(MANAGED_TEST_PROVIDER, "test-key", {
    allowNetwork: false,
  });
  const model = modelRuntime.getModel(
    MANAGED_TEST_PROVIDER,
    MANAGED_TEST_MODEL,
  );
  if (!model) {
    throw new Error("Test model registration failed.");
  }
  const modelRegistry = {
    find: (provider: string, modelId: string) =>
      provider === MANAGED_TEST_PROVIDER && modelId === MANAGED_TEST_MODEL
        ? model
        : undefined,
  };
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const sessions: AgentSession[] = [];
  const createSession = async (
    options: Parameters<typeof createAgentSession>[0] = {},
  ) => {
    const cwd = options.cwd ?? MANAGED_TEST_CWD;
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      ...options,
      cwd,
      model,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "builtin",
    });
    sessions.push(created.session);
    return { session: created.session };
  };
  return { createSession, faux, model, modelRegistry, sessions };
}

export function managedSessionContext(harness: {
  model: unknown;
  modelRegistry: unknown;
}) {
  return {
    cwd: MANAGED_TEST_CWD,
    model: harness.model,
    modelRegistry: harness.modelRegistry,
  };
}
