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

export function parsePlan(path: string, content: string): ParsedPlan {
  const lines = content.split(/\r?\n/);
  const tasksHeading = lines.findIndex((line) =>
    /^##[ \t]+Tasks[ \t]*$/.test(line),
  );
  if (tasksHeading === -1) {
    throw new Error("Plan does not contain a ## Tasks section.");
  }
  let end = lines.length;
  for (let i = tasksHeading + 1; i < lines.length; i++) {
    if (/^##[ \t]+/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const candidates: Array<{
    lineIndex: number;
    indent: string;
    checked: boolean;
    text: string;
    originalLine: string;
  }> = [];
  for (let i = tasksHeading + 1; i < end; i++) {
    const match = CHECKBOX_RE.exec(lines[i]);
    if (!match) {
      continue;
    }
    candidates.push({
      lineIndex: i,
      indent: match[1] ?? "",
      checked: (match[2] ?? " ").toLowerCase() === "x",
      text: match[3] ?? "",
      originalLine: lines[i],
    });
  }
  if (candidates.length === 0) {
    return {
      path,
      content,
      lines,
      tasksStartLine: tasksHeading + 1,
      tasksEndLine: end + 1,
      tasks: [],
    };
  }

  const minIndent = Math.min(
    ...candidates.map((candidate) => candidate.indent.length),
  );
  const executable = candidates.filter(
    (candidate) => candidate.indent.length === minIndent,
  );
  const tasks = executable.map((candidate, i): PlanTask => {
    const next = executable[i + 1]?.lineIndex ?? end;
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
    tasksStartLine: tasksHeading + 1,
    tasksEndLine: end + 1,
    tasks,
  };
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
