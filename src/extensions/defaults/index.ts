import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

type ModelDefaults = {
  cwd: string;
  provider: string;
  modelId: string;
};

type ThinkingLevel = NonNullable<
  ReturnType<SettingsManager["getDefaultThinkingLevel"]>
>;

type ThinkingDefault = {
  cwd: string;
  level: ThinkingLevel;
};

type DebouncedRestore<T> = {
  schedule(snapshot: T): void;
  flush(): Promise<void>;
};

const RESTORE_DELAY_MS = 200;

export default function (pi: ExtensionAPI) {
  let cachedModelDefaults: Omit<ModelDefaults, "cwd"> | undefined;
  let cachedThinkingDefault: Omit<ThinkingDefault, "cwd"> | undefined;

  const modelRestore = createDebouncedRestore(restoreModelDefaults);
  const thinkingRestore = createDebouncedRestore(restoreThinkingDefault);

  async function flushPendingRestores() {
    await Promise.all([modelRestore.flush(), thinkingRestore.flush()]);
  }

  pi.on("session_start", async (_event, ctx) => {
    await flushPendingRestores();

    cachedModelDefaults = undefined;
    cachedThinkingDefault = undefined;

    const settings = SettingsManager.create(ctx.cwd, getAgentDir());
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    if (provider && modelId) {
      cachedModelDefaults = { provider, modelId };
    }

    const level = settings.getDefaultThinkingLevel();
    if (level !== undefined) {
      cachedThinkingDefault = { level };
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    if (!cachedModelDefaults) {
      return;
    }

    modelRestore.schedule({ cwd: ctx.cwd, ...cachedModelDefaults });
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    if (!cachedThinkingDefault) {
      return;
    }

    thinkingRestore.schedule({ cwd: ctx.cwd, ...cachedThinkingDefault });
  });

  pi.on("session_shutdown", async () => {
    await flushPendingRestores();
  });
}

function createDebouncedRestore<T>(
  restore: (snapshot: T) => Promise<void>,
): DebouncedRestore<T> {
  let timer: NodeJS.Timeout | undefined;
  let pendingSnapshot: T | undefined;
  let running: Promise<void> = Promise.resolve();

  async function executePending() {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }

    const snapshot = pendingSnapshot;
    pendingSnapshot = undefined;
    if (snapshot === undefined) {
      return;
    }

    await restore(snapshot);
  }

  function queueExecution() {
    running = running.then(executePending, executePending);
    void running.catch(() => {});
  }

  return {
    schedule(snapshot) {
      pendingSnapshot = snapshot;
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        queueExecution();
      }, RESTORE_DELAY_MS);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await running;
      await executePending();
    },
  };
}

async function restoreModelDefaults(snapshot: ModelDefaults) {
  const settings = SettingsManager.create(snapshot.cwd, getAgentDir());
  const globalSettings = settings.getGlobalSettings();
  if (
    globalSettings.defaultProvider === snapshot.provider &&
    globalSettings.defaultModel === snapshot.modelId
  ) {
    return;
  }

  settings.setDefaultModelAndProvider(snapshot.provider, snapshot.modelId);
  await settings.flush();
}

async function restoreThinkingDefault(snapshot: ThinkingDefault) {
  const settings = SettingsManager.create(snapshot.cwd, getAgentDir());
  const globalSettings = settings.getGlobalSettings();
  if (globalSettings.defaultThinkingLevel === snapshot.level) {
    return;
  }

  settings.setDefaultThinkingLevel(snapshot.level);
  await settings.flush();
}
