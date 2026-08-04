import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writeAtomicJson } from "./atomic-json.js";
import type {
  CompiledExecutionTask,
  ExecutionPlan,
  ExecutionWorkstream,
  StrictCompiledContract,
} from "./execution-plan.js";
import {
  MAX_CORPUS_CHARS,
  MAX_CORPUS_FILES,
  type MaterialStore,
} from "./material-store.js";
import { resolveCorpusPath, sha256 } from "./source-integrity.js";

const VERSION = 1;

export type FrozenSourceDocument = {
  path: string;
  displayPath: string;
  hash: string;
  content: string;
};

type PersistedSourceCorpus = {
  version: 1;
  executionPlanHash: string;
  corpusHash: string;
  documents: FrozenSourceDocument[];
};

export type WorkerRequirementTask = {
  id: string;
  planIndex: number;
  title: string;
  dependsOn: string[];
  supportingDocuments: string[];
  compiledContract: StrictCompiledContract;
  sourceBlock: string;
  sourceDisplayPath: string;
  sourceLineNumber: number;
};

export type WorkerSchedule = {
  tasks: Array<
    Pick<WorkerRequirementTask, "id" | "planIndex" | "title" | "dependsOn">
  >;
  workstreams: ExecutionWorkstream[];
};

export type RequirementsContext = {
  contracts: WorkerRequirementTask[];
  corpus: Array<{ path: string; content: string }>;
  schedule: WorkerSchedule;
};

export function sourceCorpusPath(runDir: string): string {
  return join(runDir, "source-corpus.json");
}

export function writeSourceCorpus(
  runDir: string,
  materialStore: MaterialStore,
  plan: ExecutionPlan,
): void {
  const path = sourceCorpusPath(runDir);
  if (existsSync(path)) {
    throw new Error(`Source corpus already exists: ${path}`);
  }
  const documents = materialStore.files.map((file) => ({
    path: file.absolutePath,
    displayPath: file.displayPath,
    hash: file.hash,
    content: file.content,
  }));
  validateDocuments(documents, materialStore.storeHash, plan);
  writeAtomicJson(path, {
    version: VERSION,
    executionPlanHash: plan.executionPlanHash,
    corpusHash: materialStore.storeHash,
    documents,
  });
}

export function loadRequirementsContext(
  runDir: string,
  plan: ExecutionPlan,
): RequirementsContext {
  const path = sourceCorpusPath(runDir);
  if (!existsSync(path)) {
    throw new Error("Retained source corpus is missing.");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error("Retained source corpus is malformed.");
  }
  const corpus = parseCorpus(value, plan);
  const byPath = new Map(
    corpus.documents.map((document) => [document.path, document]),
  );
  const entry = byPath.get(plan.source.planPath);
  if (!entry) {
    throw new Error("Retained source corpus is missing the source plan.");
  }
  const contracts = plan.tasks.map((task) =>
    workerTask(task, plan, byPath, entry),
  );
  return {
    contracts,
    corpus: corpus.documents.map((document) => ({
      path: document.displayPath,
      content: document.content,
    })),
    schedule: {
      tasks: contracts.map(({ id, planIndex, title, dependsOn }) => ({
        id,
        planIndex,
        title,
        dependsOn,
      })),
      workstreams: plan.workstreams.map((workstream) => ({
        id: workstream.id,
        taskIds: [...workstream.taskIds],
        dependsOn: [...workstream.dependsOn],
      })),
    },
  };
}

export function scopedRequirements(
  context: RequirementsContext,
  taskIds: readonly string[],
): {
  contracts: WorkerRequirementTask[];
  sourceMaterial: Array<{ path: string; content: string }>;
} {
  const byId = new Map(context.contracts.map((task) => [task.id, task]));
  const byPath = new Map(
    context.corpus.map((document) => [document.path, document]),
  );
  const contracts = taskIds.map((id) => {
    const task = byId.get(id);
    if (!task) {
      throw new Error(`Requirements context is missing task ${id}.`);
    }
    return task;
  });
  const documentPaths = new Set(
    contracts.flatMap((task) => task.supportingDocuments),
  );
  return {
    contracts,
    sourceMaterial: [
      ...contracts.map((task) => ({
        path: `${task.sourceDisplayPath}:${task.sourceLineNumber}`,
        content: task.sourceBlock,
      })),
      ...[...documentPaths]
        .map((path) => byPath.get(path))
        .filter(
          (document): document is { path: string; content: string } =>
            document !== undefined,
        )
        .map((document) => ({
          path: document.path,
          content: document.content,
        })),
    ],
  };
}

function parseCorpus(
  value: unknown,
  plan: ExecutionPlan,
): PersistedSourceCorpus {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "version",
      "executionPlanHash",
      "corpusHash",
      "documents",
    ])
  ) {
    throw new Error("Retained source corpus has an invalid schema.");
  }
  if (
    value.version !== VERSION ||
    value.executionPlanHash !== plan.executionPlanHash ||
    value.corpusHash !== plan.source.corpusHash ||
    !Array.isArray(value.documents)
  ) {
    throw new Error(
      "Retained source corpus does not match the execution plan.",
    );
  }
  const documents = value.documents.map((document) => parseDocument(document));
  validateDocuments(documents, value.corpusHash, plan);
  return {
    version: VERSION,
    executionPlanHash: value.executionPlanHash,
    corpusHash: value.corpusHash,
    documents,
  };
}

function parseDocument(value: unknown): FrozenSourceDocument {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["path", "displayPath", "hash", "content"]) ||
    !["path", "displayPath", "hash", "content"].every(
      (key) => typeof value[key] === "string" && value[key].trim() !== "",
    )
  ) {
    throw new Error("Retained source corpus has an invalid document.");
  }
  return value as FrozenSourceDocument;
}

function validateDocuments(
  documents: FrozenSourceDocument[],
  corpusHash: string,
  plan: ExecutionPlan,
): void {
  if (documents.length === 0 || documents.length > MAX_CORPUS_FILES) {
    throw new Error("Retained source corpus exceeds its file bound.");
  }
  if (
    documents.reduce((sum, document) => sum + document.content.length, 0) >
    MAX_CORPUS_CHARS
  ) {
    throw new Error("Retained source corpus exceeds its size bound.");
  }
  if (
    new Set(documents.map((document) => document.path)).size !==
      documents.length ||
    new Set(documents.map((document) => document.displayPath)).size !==
      documents.length ||
    documents.some((document) => isAbsolute(document.displayPath))
  ) {
    throw new Error("Retained source corpus contains duplicate documents.");
  }
  const records = documents
    .map((document) => ({
      path: document.path,
      hash: document.hash,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(records) !== JSON.stringify(plan.source.corpusFiles)) {
    throw new Error(
      "Retained source corpus documents do not match the execution plan.",
    );
  }
  if (
    documents.some(
      (document) =>
        !/^[a-f0-9]{64}$/.test(document.hash) ||
        sha256(document.content) !== document.hash,
    )
  ) {
    throw new Error("Retained source corpus content hash does not match.");
  }
  const aggregate = sha256(
    [
      plan.source.planPath,
      ...documents.flatMap((document) => [document.path, document.hash]),
    ].join("\0"),
  );
  if (corpusHash !== plan.source.corpusHash || aggregate !== corpusHash) {
    throw new Error("Retained source corpus aggregate hash does not match.");
  }
}

function workerTask(
  task: CompiledExecutionTask,
  plan: ExecutionPlan,
  documents: Map<string, FrozenSourceDocument>,
  entry: FrozenSourceDocument,
): WorkerRequirementTask {
  const supportingDocuments = task.supportingDocuments.flatMap((reference) => {
    const displayed = [...documents.values()].find(
      (document) => document.displayPath === reference,
    );
    if (displayed) {
      return displayed.path === plan.source.planPath
        ? []
        : [displayed.displayPath];
    }
    try {
      const path = resolveCorpusPath({
        planPath: plan.source.planPath,
        checkoutRoot: "",
        corpus: plan.source.corpusFiles,
        reference,
      });
      const document = documents.get(path);
      return document && path !== plan.source.planPath
        ? [document.displayPath]
        : [];
    } catch {
      return [];
    }
  });
  return {
    id: task.id,
    planIndex: task.planIndex,
    title: task.title,
    dependsOn: [...task.dependsOn],
    supportingDocuments,
    compiledContract: task.compiledContract,
    sourceBlock: task.sourceBlock,
    sourceDisplayPath: entry.displayPath,
    sourceLineNumber: task.sourceAnchor.lineNumber,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => key in value)
  );
}
