import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createEventBus,
  type Extension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const expectedExtensions = [
  "./src/extensions/guard/index.ts",
  "./src/extensions/edit-approval/index.ts",
  "./src/extensions/context/index.ts",
  "./src/extensions/defaults/index.ts",
  "./src/extensions/ui/index.ts",
  "./src/extensions/personality/index.ts",
  "./src/extensions/lsp/index.ts",
  "./src/extensions/subagents/index.ts",
  "./src/extensions/implement/index.ts",
  "./src/extensions/papercuts/index.ts",
  "./src/extensions/btw/index.ts",
  "./src/extensions/caffeinate/index.ts",
];
const expectedExtensionPaths = expectedExtensions.map((path) => path.slice(2));
const manifest = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
) as {
  pi: { extensions: string[] };
  workspaces?: unknown;
};

const expectedTools = {
  context_recall: "src/extensions/context/index.ts",
  lsp: "src/extensions/lsp/index.ts",
  Agent: "src/extensions/subagents/index.ts",
  get_subagent_result: "src/extensions/subagents/index.ts",
  steer_subagent: "src/extensions/subagents/index.ts",
  propose_papercut: "src/extensions/papercuts/index.ts",
};

const expectedCommands = {
  guard: "src/extensions/guard/index.ts",
  readonly: "src/extensions/edit-approval/index.ts",
  agents: "src/extensions/subagents/index.ts",
  implement: "src/extensions/implement/index.ts",
  papercuts: "src/extensions/papercuts/index.ts",
  btw: "src/extensions/btw/index.ts",
};

const expectedRenderers = {};

const safetyPaths = [
  "src/extensions/guard/index.ts",
  "src/extensions/edit-approval/index.ts",
];
const managedGlobalSymbols = [
  Symbol.for("pipkin:subagents:manager"),
  Symbol.for("pipkin:lsp:pool"),
  Symbol.for("pipkin:lsp:unavailable-warnings"),
];
const runtimeManagerKey = Symbol.for("pipkin:subagents:manager");

type BundleFixture = {
  agentDir: string;
  eventBus: ReturnType<typeof createEventBus>;
  loader: DefaultResourceLoader;
  result: LoadExtensionsResult;
  dispose: () => Promise<void>;
};

type GlobalSymbolState = {
  symbol: symbol;
  exists: boolean;
  value: unknown;
};

const fixtures: BundleFixture[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    await fixtures.pop()?.dispose();
  }
});

function getConfigPath(agentDir: string): string {
  return join(agentDir, "pipkin", "config.json");
}

function snapshotGlobalSymbols(): GlobalSymbolState[] {
  const globalScope = globalThis as Record<symbol, unknown>;
  return managedGlobalSymbols.map((symbol) => ({
    symbol,
    exists: Object.hasOwn(globalScope, symbol),
    value: globalScope[symbol],
  }));
}

async function disposeRuntimeFor(eventBus: ReturnType<typeof createEventBus>) {
  const manager = (globalThis as Record<symbol, unknown>)[runtimeManagerKey] as
    | {
        coordinators?: WeakMap<
          object,
          { runtime?: { dispose?: () => Promise<void> } }
        >;
      }
    | undefined;
  await manager?.coordinators?.get(eventBus)?.runtime?.dispose?.();
}

function restoreGlobalSymbols(states: readonly GlobalSymbolState[]): void {
  const globalScope = globalThis as Record<symbol, unknown>;
  for (const { symbol, exists, value } of states) {
    if (exists) {
      globalScope[symbol] = value;
    } else {
      delete globalScope[symbol];
    }
  }
}

async function loadBundle(): Promise<BundleFixture> {
  const agentDir = mkdtempSync(join(tmpdir(), "pipkin-bundle-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const exitListeners = new Set(process.listeners("exit"));
  const globals = snapshotGlobalSymbols();
  const eventBus = createEventBus();
  const configPath = getConfigPath(agentDir);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      models: {
        utility: { model: "openai/gpt-4o", thinking: "off" },
        low: { model: "openai/gpt-4o", thinking: "low" },
        medium: { model: "openai/gpt-4o", thinking: "medium" },
        high: { model: "openai/gpt-4o", thinking: "high" },
      },
    }),
    { encoding: "utf8", flush: true },
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const dispose = async () => {
    await disposeRuntimeFor(eventBus);
    eventBus.clear();
    for (const listener of process.listeners("exit")) {
      if (!exitListeners.has(listener)) {
        process.removeListener("exit", listener);
      }
    }
    restoreGlobalSymbols(globals);
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    rmSync(agentDir, { force: true, recursive: true });
  };

  try {
    const loader = new DefaultResourceLoader({
      cwd: ROOT,
      agentDir,
      eventBus,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [ROOT],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const fixture = {
      agentDir,
      eventBus,
      loader,
      result: loader.getExtensions(),
      dispose,
    };
    fixtures.push(fixture);
    return fixture;
  } catch (error) {
    await dispose();
    throw error;
  }
}

function relativeExtensionPath(extension: Extension): string {
  return relative(ROOT, extension.resolvedPath);
}

function ownerMap(
  extensions: readonly Extension[],
  key: "messageRenderers",
): Record<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const extension of extensions) {
    for (const name of extension[key].keys()) {
      const entries = owners.get(name) ?? [];
      entries.push(relativeExtensionPath(extension));
      owners.set(name, entries);
    }
  }
  return Object.fromEntries(
    [...owners.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

function provenanceMap(
  extensions: readonly Extension[],
  key: "tools" | "commands",
): Record<string, string[]> {
  const sources = new Map<string, string[]>();
  for (const extension of extensions) {
    for (const [name, registration] of extension[key]) {
      const entries = sources.get(name) ?? [];
      entries.push(relative(ROOT, registration.sourceInfo.path));
      sources.set(name, entries);
    }
  }
  return Object.fromEntries(
    [...sources.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

function expectedProvenance(
  expected: Record<string, string>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(expected)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, owner]) => [name, [owner]]),
  );
}

function safetyExtensions(result: LoadExtensionsResult): Extension[] {
  return result.extensions.filter((extension) =>
    safetyPaths.includes(relativeExtensionPath(extension)),
  );
}

async function createSafetyRunner(
  fixture: BundleFixture,
  reason: "startup" | "reload",
): Promise<{
  runner: ExtensionRunner;
  extensions: Extension[];
  errors: string[];
}> {
  const extensions = safetyExtensions(fixture.result);
  expect(extensions.map(relativeExtensionPath)).toEqual(safetyPaths);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(fixture.agentDir, "auth.json"),
    modelsPath: join(fixture.agentDir, "models.json"),
  });
  const runner = new ExtensionRunner(
    extensions,
    fixture.result.runtime,
    ROOT,
    SessionManager.inMemory(ROOT),
    new ModelRegistry(modelRuntime),
  );
  const errors: string[] = [];
  runner.onError((error) =>
    errors.push(`${error.extensionPath}: ${error.error}`),
  );
  runner.bindCore(
    {
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      refreshTools: () => {},
      getCommands: () => [],
      setModel: async () => false,
      getThinkingLevel: () => "off",
      setThinkingLevel: () => {},
    },
    {
      getModel: () => undefined,
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
    },
  );
  await runner.emit({ type: "session_start", reason });
  return { runner, extensions, errors };
}

async function assertSafetyOrder(
  fixture: BundleFixture,
  reason: "startup" | "reload",
): Promise<void> {
  const { runner, extensions, errors } = await createSafetyRunner(
    fixture,
    reason,
  );
  const calls: string[] = [];

  for (const extension of extensions) {
    const handlers = extension.handlers.get("tool_call");
    expect(handlers).toBeDefined();
    extension.handlers.set(
      "tool_call",
      handlers?.map((handler) => async (...args: unknown[]) => {
        calls.push(relativeExtensionPath(extension));
        return handler(...args);
      }) ?? [],
    );
  }

  await runner.emitToolCall({
    type: "tool_call",
    toolCallId: `safety-order-${reason}`,
    toolName: "pipkin_bundle_probe",
    input: {},
  });
  expect(calls).toEqual(safetyPaths);
  await runner.emit({ type: "session_shutdown", reason: "reload" });
  expect(errors).toEqual([]);
}

const ignoredProjectDirectories = new Set([
  join(ROOT, ".git"),
  join(ROOT, ".pi"),
  join(ROOT, "node_modules"),
  join(ROOT, "tmp"),
]);

function projectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredProjectDirectories.has(path) ? [] : projectFiles(path);
    }
    return [path];
  });
}

describe("Pipkin bundle", () => {
  it("loads the fixed manifest inventory through Pi's package loader", async () => {
    const fixture = await loadBundle();

    expect(manifest.pi.extensions).toEqual(expectedExtensions);
    expect(fixture.result.errors).toEqual([]);
    expect(fixture.result.extensions.map(relativeExtensionPath)).toEqual(
      expectedExtensionPaths,
    );
    expect(
      new Set(fixture.result.extensions.map(relativeExtensionPath)).size,
    ).toBe(expectedExtensions.length);
    for (const extension of fixture.result.extensions) {
      expect(relative(ROOT, extension.sourceInfo.path)).toBe(
        relativeExtensionPath(extension),
      );
    }
  });

  it("assigns every factory-time public registration to its expected feature", async () => {
    const fixture = await loadBundle();

    expect(provenanceMap(fixture.result.extensions, "tools")).toEqual(
      expectedProvenance(expectedTools),
    );
    expect(provenanceMap(fixture.result.extensions, "commands")).toEqual(
      expectedProvenance(expectedCommands),
    );
    expect(ownerMap(fixture.result.extensions, "messageRenderers")).toEqual(
      expectedProvenance(expectedRenderers),
    );
  });

  it("keeps safety startup and reload handlers ordered and registers Guard", async () => {
    const fixture = await loadBundle();
    await assertSafetyOrder(fixture, "startup");
    expect(provenanceMap(safetyExtensions(fixture.result), "tools")).toEqual(
      expectedProvenance({ bash: "src/extensions/guard/index.ts" }),
    );
    expect(provenanceMap(safetyExtensions(fixture.result), "commands")).toEqual(
      expectedProvenance({
        guard: "src/extensions/guard/index.ts",
        readonly: "src/extensions/edit-approval/index.ts",
      }),
    );

    await fixture.loader.reload();
    fixture.result = fixture.loader.getExtensions();
    expect(fixture.result.errors).toEqual([]);
    await assertSafetyOrder(fixture, "reload");
  });

  it("resolves internal modules without mutating Pipkin runtime state", async () => {
    vi.resetModules();
    const before = snapshotGlobalSymbols();
    const [{ getConfigPath }, { getSubagentRuntime }] = await Promise.all([
      import("#lib/config"),
      import("#subagents/runtime"),
    ]);

    expect(getConfigPath("/tmp/pipkin-agent")).toBe(
      "/tmp/pipkin-agent/pipkin/config.json",
    );
    expect(getSubagentRuntime).toBeTypeOf("function");
    expect(snapshotGlobalSymbols()).toEqual(before);
  });

  it("contains no package-era topology or cross-feature entrypoint imports", () => {
    expect(manifest.workspaces).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain("workspace:");
    expect(existsSync(join(ROOT, "packages"))).toBe(false);
    expect(existsSync(join(ROOT, "lib", "src"))).toBe(false);

    const files = projectFiles(ROOT);
    expect(files.filter((path) => path.endsWith("package.json"))).toEqual([
      join(ROOT, "package.json"),
    ]);
    expect(
      files.filter((path) => /vitest\.config\.[cm]?[jt]s$/.test(path)),
    ).toEqual([join(ROOT, "vitest.config.ts")]);

    for (const path of files.filter(
      (candidate) =>
        candidate.startsWith(join(ROOT, "src")) &&
        /\.[cm]?[jt]s$/.test(candidate) &&
        !/\.test\.[cm]?[jt]s$/.test(candidate),
    )) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/@pi-extensions\//);
      expect(source).not.toMatch(/pi-subagents\/runtime/);
      expect(source).not.toMatch(
        /(?:from|import)\s*\(?["'][^"']*extensions\/[^"']+\/index(?:\.ts|\.js)?["']/,
      );
    }
  });
});
