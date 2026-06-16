import { readFileSync } from "node:fs";
import { parsePlanFile } from "./plan.js";
import {
  buildMaterialStore,
  buildMaterialStoreFromContent,
  formatStoreCorpusMaterial,
  MAX_CORPUS_CHARS,
  MAX_CORPUS_FILES,
  type MaterialStore,
} from "./material-store.js";

export { MAX_CORPUS_FILES, MAX_CORPUS_CHARS };

export type CorpusFile = {
  absolutePath: string;
  displayPath: string;
  content: string;
  hash: string;
};

export type PlanCorpus = {
  entryPath: string;
  entryHash: string;
  files: CorpusFile[];
  corpusHash: string;
  validationErrors: string[];
};

export function ingestPlanCorpus(entryPath: string): PlanCorpus {
  return ingestPlanCorpusFromStore(buildMaterialStoreForCorpus(entryPath));
}

export function buildMaterialStoreForCorpus(entryPath: string): MaterialStore {
  try {
    const plan = parsePlanFile(entryPath);
    return buildMaterialStore({ plan, planPath: entryPath });
  } catch {
    const content = readFileSync(entryPath, "utf-8");
    return buildMaterialStoreFromContent(entryPath, content);
  }
}

export function ingestPlanCorpusFromStore(store: MaterialStore): PlanCorpus {
  const entryFile = store.files.find(
    (file) => file.absolutePath === store.entryPath,
  );
  const files: CorpusFile[] = store.files.map((file) => ({
    absolutePath: file.absolutePath,
    displayPath: file.displayPath,
    content: file.content,
    hash: file.hash,
  }));

  const validationErrors: string[] = store.validationErrors.filter(
    (error) => !/^Task \d+:/.test(error),
  );

  if (files.length > MAX_CORPUS_FILES) {
    validationErrors.push(
      `corpus exceeds maximum file count of ${MAX_CORPUS_FILES} (${files.length} files)`,
    );
  }

  const totalChars = files.reduce((sum, f) => sum + f.content.length, 0);
  if (totalChars > MAX_CORPUS_CHARS) {
    validationErrors.push(
      `corpus exceeds maximum size of ${MAX_CORPUS_CHARS} characters (${totalChars} characters)`,
    );
  }

  return {
    entryPath: store.entryPath,
    entryHash: entryFile?.hash ?? "",
    files,
    corpusHash: store.storeHash,
    validationErrors,
  };
}

export function formatCorpusMaterial(corpus: PlanCorpus): string {
  const store = materialStoreFromCorpus(corpus);
  return formatStoreCorpusMaterial(store);
}

export function materialStoreFromCorpus(corpus: PlanCorpus): MaterialStore {
  return {
    entryPath: corpus.entryPath,
    planDir: corpus.entryPath,
    allowedRoots: [corpus.entryPath],
    files: corpus.files.map((file) => ({
      ...file,
      lineCount: file.content.split(/\r?\n/).length,
      origins:
        file.absolutePath === corpus.entryPath
          ? ["entry-plan" as const]
          : ["corpus-link" as const],
      taskOrigins: [],
    })),
    storeHash: corpus.corpusHash,
    validationErrors: corpus.validationErrors,
  };
}
