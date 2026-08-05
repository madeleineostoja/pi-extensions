import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { executeSandboxBash } from "#sandbox/bash";
import {
  toolCallRenderer,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
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
      "Run a Sandbox Bash command and retain a successful result for later recall. Successful calls return concise status while failures remain visible.",
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
    renderCall: toolCallRenderer({
      name: "bash_outcome",
      detail: (args) => `$ ${formatBashTarget(args.command)}`,
      pending: "Running…",
    }),
    renderResult: toolResultRenderer({
      summary(result) {
        return (
          firstText(result.content).split("\n", 1)[0] ??
          "Bash command succeeded."
        );
      },
      partial() {
        return "Running…";
      },
      error(result) {
        return (
          firstText(result.content).split("\n", 1)[0] ?? "Bash command failed."
        );
      },
      expandedContent(result) {
        return decodeRetainedResult(result.details)?.content ?? result.content;
      },
    }),
  });
}

function isNoOutputResult(result: Readonly<{ content: unknown }>): boolean {
  return (
    Array.isArray(result.content) &&
    result.content.length === 1 &&
    firstText(result.content) === "(no output)"
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
