import { createHash } from "node:crypto";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, basename } from "node:path";

export const MAX_CORPUS_FILES = 50;
export const MAX_CORPUS_CHARS = 200_000;

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

const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateCorpusTarget(
  sourceDir: string,
  target: string,
): { absolutePath: string; content: string } | string {
  if (looksLikeUrl(target)) {
    return `URL corpus link target: ${target}`;
  }

  const absolutePath = isAbsolute(target)
    ? resolve(target)
    : resolve(join(sourceDir, target));

  try {
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      return `corpus link target is a directory: ${target}`;
    }
  } catch {
    return `missing or unreadable corpus link target: ${target}`;
  }

  if (!target.toLowerCase().endsWith(".md")) {
    return `non-markdown corpus link target: ${target}`;
  }

  let content: string;
  try {
    content = readFileSync(absolutePath, "utf-8");
  } catch {
    return `missing or unreadable corpus link target: ${target}`;
  }

  if (!content.trim()) {
    return `empty or whitespace-only corpus link target: ${target}`;
  }

  return { absolutePath, content };
}

function isInTasksDirectory(absolutePath: string): boolean {
  return basename(dirname(absolutePath)) === "tasks";
}

function discoverSiblingTasks(taskDir: string): string[] {
  try {
    return readdirSync(taskDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md"))
      .map((d) => join(taskDir, d.name));
  } catch {
    return [];
  }
}

export function ingestPlanCorpus(entryPath: string): PlanCorpus {
  const entryContent = readFileSync(entryPath, "utf-8");
  const entryHash = hashContent(entryContent);
  const sourceDir = dirname(entryPath);

  const entryAbsolutePath = resolve(entryPath);
  const seen = new Set<string>([entryAbsolutePath]);
  const files: CorpusFile[] = [
    {
      absolutePath: entryAbsolutePath,
      displayPath: basename(entryAbsolutePath),
      content: entryContent,
      hash: hashContent(entryContent),
    },
  ];
  const validationErrors: string[] = [];

  const addFile = (absolutePath: string, content: string) => {
    if (seen.has(absolutePath)) {
      return;
    }
    seen.add(absolutePath);
    files.push({
      absolutePath,
      displayPath: basename(absolutePath),
      content,
      hash: hashContent(content),
    });
  };

  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_LINK_RE.exec(entryContent)) !== null) {
    const start = match.index;
    if (start > 0 && entryContent[start - 1] === "!") {
      continue;
    }
    const target = (match[2] ?? "").trim();
    if (!target) {
      continue;
    }
    links.push(target);
  }

  for (const target of links) {
    const validation = validateCorpusTarget(sourceDir, target);
    if (typeof validation === "string") {
      validationErrors.push(validation);
      continue;
    }

    addFile(validation.absolutePath, validation.content);

    if (isInTasksDirectory(validation.absolutePath)) {
      const siblingPaths = discoverSiblingTasks(
        dirname(validation.absolutePath),
      );
      for (const siblingPath of siblingPaths) {
        if (seen.has(siblingPath)) {
          continue;
        }
        try {
          const siblingContent = readFileSync(siblingPath, "utf-8");
          if (!siblingContent.trim()) {
            validationErrors.push(
              `empty or whitespace-only corpus file: ${siblingPath}`,
            );
            continue;
          }
          addFile(siblingPath, siblingContent);
        } catch {
          validationErrors.push(
            `missing or unreadable corpus file: ${siblingPath}`,
          );
        }
      }
    }
  }

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

  const hash = createHash("sha256");
  hash.update(entryHash);
  for (const file of files) {
    hash.update(file.hash);
  }
  const corpusHash = hash.digest("hex");

  return {
    entryPath: resolve(entryPath),
    entryHash,
    files,
    corpusHash,
    validationErrors,
  };
}

export function formatCorpusMaterial(corpus: PlanCorpus): string {
  if (corpus.files.length <= 1) {
    return "";
  }
  const parts: string[] = [];
  for (const file of corpus.files) {
    if (file.absolutePath === corpus.entryPath) {
      continue;
    }
    parts.push(`### ${file.displayPath}\n\n${file.content}`);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join("\n\n");
}
