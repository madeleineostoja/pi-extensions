import { readFileSync, writeFileSync } from "node:fs";
import { normalizeCheckboxMarker } from "./source-checkbox.js";

export type PlanTask = {
  index: number;
  lineNumber: number;
  indent: string;
  checked: boolean;
  originalLine: string;
  text: string;
  blockLines: string[];
};

export type ParsedPlan = {
  path: string;
  content: string;
  lines: string[];
  tasksStartLine: number;
  tasksEndLine: number;
  tasks: PlanTask[];
};

const CHECKBOX_RE = /^([ \t]*)[-*][ \t]+\[([ xX])\][ \t]+(.+)$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

type CheckboxCandidate = {
  lineIndex: number;
  indent: string;
  checked: boolean;
  text: string;
  originalLine: string;
};

type CheckboxSection = {
  heading: string;
  startIndex: number;
  endIndex: number;
  candidates: CheckboxCandidate[];
};

export function parsePlan(path: string, content: string): ParsedPlan {
  const lines = content.split(/\r?\n/);
  const sections = checkboxSections(lines);
  const candidateSections = sections.filter(
    (section) => section.candidates.length > 0,
  );

  if (candidateSections.length === 0) {
    throw new Error(
      "No checkbox task section found. Add a single Markdown section containing supported task checkboxes like '- [ ] Task' or '* [ ] Task'.",
    );
  }

  if (candidateSections.length > 1) {
    throw new Error(
      `Multiple checkbox task sections found. Keep executable task checkboxes in exactly one section, or remove checkboxes from the others. Candidates:\n${candidateSections
        .map((section) => `- ${formatSectionRange(section)}`)
        .join("\n")}`,
    );
  }

  const section = candidateSections[0];
  const minIndent = Math.min(
    ...section.candidates.map((candidate) => candidate.indent.length),
  );
  const executable = section.candidates.filter(
    (candidate) => candidate.indent.length === minIndent,
  );
  const tasks = executable.map((candidate, i): PlanTask => {
    const next = executable[i + 1]?.lineIndex ?? section.endIndex;
    const blockLines = lines.slice(candidate.lineIndex + 1, next);
    return {
      index: i + 1,
      lineNumber: candidate.lineIndex + 1,
      indent: candidate.indent,
      checked: candidate.checked,
      originalLine: candidate.originalLine,
      text: candidate.text,
      blockLines,
    };
  });

  return {
    path,
    content,
    lines,
    tasksStartLine: section.startIndex + 1,
    tasksEndLine: section.endIndex + 1,
    tasks,
  };
}

function checkboxSections(lines: string[]): CheckboxSection[] {
  const sections: CheckboxSection[] = [
    {
      heading: "(headingless)",
      startIndex: 0,
      endIndex: lines.length,
      candidates: [],
    },
  ];

  for (let i = 0; i < lines.length; i++) {
    const heading = HEADING_RE.exec(lines[i]);
    if (heading) {
      const previous = sections[sections.length - 1];
      previous.endIndex = i;
      sections.push({
        heading: heading[2] ?? "(untitled heading)",
        startIndex: i,
        endIndex: lines.length,
        candidates: [],
      });
      continue;
    }

    const match = CHECKBOX_RE.exec(lines[i]);
    if (!match) {
      continue;
    }
    const section = sections[sections.length - 1];
    section.candidates.push({
      lineIndex: i,
      indent: match[1] ?? "",
      checked: (match[2] ?? " ").toLowerCase() === "x",
      text: match[3] ?? "",
      originalLine: lines[i],
    });
  }

  return sections;
}

function formatSectionRange(section: CheckboxSection): string {
  const startLine = section.startIndex + 1;
  const endLine = Math.max(startLine, section.endIndex);
  return `${section.heading} (lines ${startLine}-${endLine})`;
}

export function parsePlanFile(path: string): ParsedPlan {
  return parsePlan(path, readFileSync(path, "utf-8"));
}

export function nextUncheckedTask(plan: ParsedPlan): PlanTask | undefined {
  return plan.tasks.find((task) => !task.checked);
}

export function markTaskDoneInContent(content: string, task: PlanTask): string {
  return replaceTaskMarker(content, task, "x");
}

export function markTaskUndoneInContent(
  content: string,
  task: PlanTask,
): string {
  return replaceTaskMarker(content, task, " ");
}

export function markTaskDone(path: string, task: PlanTask): void {
  const content = readFileSync(path, "utf-8");
  writeFileSync(path, markTaskDoneInContent(content, task), "utf-8");
}

export function markTaskUndone(path: string, task: PlanTask): void {
  const content = readFileSync(path, "utf-8");
  writeFileSync(path, markTaskUndoneInContent(content, task), "utf-8");
}

function replaceTaskMarker(
  content: string,
  task: PlanTask,
  marker: "x" | " ",
): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const index = task.lineNumber - 1;
  if (
    normalizeCheckboxMarker(lines[index]) ===
    normalizeCheckboxMarker(task.originalLine)
  ) {
    lines[index] = replaceMarker(lines[index], marker);
    return lines.join(lineEnding);
  }

  throw new Error(
    `Stale source checkbox: line ${task.lineNumber} no longer matches recorded text.`,
  );
}

function replaceMarker(line: string, marker: "x" | " "): string {
  return line.replace(/\[([ xX])\]/, `[${marker}]`);
}
