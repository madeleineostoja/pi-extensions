// After-consumption bash compaction classifier.
// Determines whether a successful bash output is low-risk enough to compact
// after the assistant has already seen it once.

// High-risk markers that should prevent compaction even if isError is false.
const HIGH_RISK_MARKERS =
  /Traceback|AssertionError|Exception|panic:|segmentation fault|Command failed|\bFAILED\b|\bFAIL\b|\bERR!|\berror:|\bnot ok\b|[✗✖]/i;

// Source-like lines that suggest the output is code/file content, not logs.
const SOURCE_LIKE_LINE =
  /^\s*(import|export|const|let|var|function|class|type\s+\w|interface\s+\w|def\s+\w|public\s+|private\s+|protected\s+|if\s*\(|for\s*\(|while\s*\(|return\b|([{}])|(<\/?\w+))/;

export type BashClassification = {
  lowRisk: boolean;
  estimatedSavedTokens: number;
};

function joinContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n");
}

function normalizeForRepetition(line: string): string {
  return line
    .trim()
    .replace(/\d+/g, "#")
    .replace(/\b(?:\/[\w-.]+)+\b/g, "<path>")
    .replace(/\b(?:[A-Za-z]:\\[\w-.\\]+)+\b/g, "<path>")
    .slice(0, 24);
}

function countNonblankLines(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) {
      count++;
    }
  }
  return count;
}

function uniqueLineRatio(text: string): number {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return 0;
  }
  const unique = new Set(lines.map((l) => l.trim()));
  return unique.size / lines.length;
}

function maxPrefixFrequency(text: string): number {
  const prefixes = new Map<string, number>();
  for (const line of text.split("\n")) {
    const norm = normalizeForRepetition(line);
    if (norm.length === 0) {
      continue;
    }
    prefixes.set(norm, (prefixes.get(norm) ?? 0) + 1);
  }
  let max = 0;
  for (const count of prefixes.values()) {
    if (count > max) {
      max = count;
    }
  }
  return max;
}

function sourceLikeLineRatio(text: string): number {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return 0;
  }
  let sourceLike = 0;
  for (const line of lines) {
    if (SOURCE_LIKE_LINE.test(line)) {
      sourceLike++;
    }
  }
  return sourceLike / lines.length;
}

export function classifyBashOutput(
  content: Array<{ type: string; text?: string }>,
  originalTokens: number,
  minSavedTokens: number,
): BashClassification {
  const text = joinContent(content);
  const estimatedSavedTokens = originalTokens;

  if (estimatedSavedTokens < minSavedTokens) {
    return { lowRisk: false, estimatedSavedTokens };
  }

  if (HIGH_RISK_MARKERS.test(text)) {
    return { lowRisk: false, estimatedSavedTokens };
  }

  if (sourceLikeLineRatio(text) >= 0.3) {
    return { lowRisk: false, estimatedSavedTokens };
  }

  const nonblankCount = countNonblankLines(text);
  const uniqueRatio = uniqueLineRatio(text);
  const prefixFreq = maxPrefixFrequency(text);

  const hasLogSignal =
    (nonblankCount >= 50 && uniqueRatio <= 0.7) ||
    prefixFreq >= 10 ||
    originalTokens >= 5000;

  if (!hasLogSignal) {
    return { lowRisk: false, estimatedSavedTokens };
  }

  return { lowRisk: true, estimatedSavedTokens };
}
