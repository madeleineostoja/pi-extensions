import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { executeSandboxBash } from "#sandbox/bash";
import { Type } from "typebox";
import { formatBashTarget } from "./bash-target.ts";
import { decodeRetainedResult, retainResult } from "./retained-result.ts";

const BashOutcomeParams = Type.Object(
  {
    command: Type.String({ description: "The Bash command to execute" }),
    label: Type.Optional(
      Type.String({
        description: "Optional display-only label for a successful command",
      }),
    ),
    timeout: Type.Optional(
      Type.Number({ description: "Optional timeout in seconds" }),
    ),
  },
  { additionalProperties: false },
);

export function registerBashOutcomeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bash_outcome",
    label: "bash_outcome",
    description:
      "Run Bash through Sandbox when exit status alone answers the current question. Successful output remains immediately recallable; a successful command with no output returns only concise status; failures remain visible.",
    promptSnippet:
      "bash_outcome — run an action or validation when exit status alone is enough; recall successful output if needed",
    promptGuidelines: [
      "Use bash_outcome for an action or validation when exit status alone answers the current question, especially when successful output may be noisy. The command may take any finite duration.",
      "Use bash for inspection, discovery, diagnostics, or when successful output informs reasoning or reporting, such as search results, diffs, listings, warnings, skipped tests, or test counts.",
      "After a successful bash_outcome with output, use context_recall with its tool-call ID if that execution's output later becomes relevant; do not rerun solely to inspect it. A successful command with no output returns only concise status. Failure output remains visible, including for chained commands.",
    ],
    parameters: BashOutcomeParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!pi.getActiveTools().includes("bash")) {
        throw new Error("bash_outcome: bash is inactive");
      }
      const label =
        params.label === undefined
          ? "Bash command"
          : normalizeLabel(params.label);
      const result = await executeSandboxBash(pi.events, {
        toolCallId,
        params:
          params.timeout === undefined
            ? { command: params.command }
            : { command: params.command, timeout: params.timeout },
        signal,
        onUpdate,
        ctx,
      });
      const noOutput = isNoOutputResult(result);
      return retainResult(
        result,
        `${label} succeeded${noOutput ? " (no output)" : ""}.`,
        toolCallId,
        { includeRecallGuidance: !noOutput },
      );
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("bash_outcome"))} ${theme.fg("accent", `$ ${formatBashTarget(args.command)}`)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      if (context.isError) {
        return new Text(theme.fg("error", firstText(result.content)), 0, 0);
      }
      if (options.isPartial) {
        if (!options.expanded) {
          return new Text(theme.fg("muted", "Running…"), 0, 0);
        }
        const output = firstText(result.content);
        return new Text(
          output.length > 0
            ? theme.fg("toolOutput", output)
            : theme.fg("muted", "Running…"),
          0,
          0,
        );
      }
      const status =
        firstText(result.content).split("\n", 1)[0] ??
        "Bash command succeeded.";
      if (!options.expanded) {
        return new Text(theme.fg("toolOutput", status), 0, 0);
      }
      const retained = decodeRetainedResult(result.details);
      const content =
        retained === undefined ? undefined : retainedText(retained.content);
      return new Text(
        [
          theme.fg("toolOutput", status),
          ...(content === undefined ? [] : [theme.fg("toolOutput", content)]),
        ].join("\n"),
        0,
        0,
      );
    },
  });
}

function isNoOutputResult(result: Readonly<{ content: unknown }>): boolean {
  return (
    Array.isArray(result.content) &&
    result.content.length === 1 &&
    firstText(result.content) === "(no output)"
  );
}

function retainedText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
  return (
    text || (content.length > 0 ? "Retained non-text content." : undefined)
  );
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "bash_outcome failed";
  }
  const text = content.find(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  );
  return text?.text ?? "bash_outcome failed";
}

export function normalizeLabel(label: string): string {
  const normalized = Array.from(
    stripVTControlCharacters(label),
    (character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? " "
        : character;
    },
  )
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if ([...normalized].length === 0 || [...normalized].length > 80) {
    throw new Error(
      "bash_outcome: label must normalize to 1–80 Unicode code points",
    );
  }
  return normalized;
}
