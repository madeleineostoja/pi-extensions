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

const MARKDOWN_LINK_RE = /(?<!!)\[([^\]\n]*)\]\(([^)\n]+)\)/g;

function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  }
}

function looksLikeScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function stripFragment(target: string): string {
  return target.split("#", 1)[0] ?? "";
}

function stripInlineCodeSpans(line: string): string {
  let result = "";
  for (let i = 0; i < line.length; ) {
    if (line[i] !== "`") {
      result += line[i];
      i++;
      continue;
    }

    let tickCount = 1;
    while (line[i + tickCount] === "`") {
      tickCount++;
    }
    const closing = line.indexOf("`".repeat(tickCount), i + tickCount);
    if (closing === -1) {
      result += " ".repeat(tickCount);
      i += tickCount;
      continue;
    }
    result += " ".repeat(closing + tickCount - i);
    i = closing + tickCount;
  }
  return result;
}

function isPlaceholderMarkdownExample(label: string, target: string): boolean {
  const targetPath = stripFragment(target).trim().toLowerCase();
  const targetName = basename(targetPath);
  return (
    /^example(?:[-_][\w-]+)?$/i.test(label.trim()) &&
    /^(?:placeholder|example)(?:[-_][\w-]+)?\.md$/i.test(targetName)
  );
}

function discoverInlineMarkdownLinks(content: string): string[] {
  const targets: string[] = [];
  let fenced: { marker: "`" | "~"; length: number } | undefined;

  for (const line of content.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const markerText = fence[1] ?? "";
      const marker = markerText[0] as "`" | "~";
      if (fenced) {
        if (fenced.marker === marker && markerText.length >= fenced.length) {
          fenced = undefined;
        }
      } else {
        fenced = { marker, length: markerText.length };
      }
      continue;
    }

    if (fenced) {
      continue;
    }

    const searchable = stripInlineCodeSpans(line);
    let match: RegExpExecArray | null;
    while ((match = MARKDOWN_LINK_RE.exec(searchable)) !== null) {
      const label = match[1] ?? "";
      const target = (match[2] ?? "").trim();
      if (!target || looksLikeScheme(target) || target.startsWith("#")) {
        continue;
      }
      const targetPath = stripFragment(target).trim();
      if (!targetPath || !targetPath.toLowerCase().endsWith(".md")) {
        continue;
      }
      if (isPlaceholderMarkdownExample(label, target)) {
        continue;
      }
      targets.push(target);
    }
  }

  return targets;
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

  const targetPath = stripFragment(target).trim();
  if (!targetPath) {
    return `missing or unreadable corpus link target: ${target}`;
  }

  if (!targetPath.toLowerCase().endsWith(".md")) {
    return `non-markdown corpus link target: ${target}`;
  }

  const absolutePath = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(join(sourceDir, targetPath));

  try {
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      return `corpus link target is a directory: ${target}`;
    }
  } catch {
    return `missing or unreadable corpus link target: ${target}`;
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

  for (const target of discoverInlineMarkdownLinks(entryContent)) {
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
