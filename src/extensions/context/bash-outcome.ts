import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { executeSandboxBash } from "#sandbox/bash";
import { Type } from "typebox";
import { retainResult } from "./retained-result.ts";

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
      "Run Bash through Sandbox when the next reasoning step only needs success. Successful ordinary Bash output remains recallable; failures remain visible.",
    promptSnippet:
      "bash_outcome — run Bash when only success matters next; recall its ordinary result if needed",
    promptGuidelines: [
      "Use bash_outcome when the next reasoning step only needs to know whether the Bash command succeeded. The command may take any finite duration.",
      "On success, the same result ordinary Bash would have returned remains available through context_recall, subject to normal Bash output limits.",
      "Use bash when successful output may affect the next decision; failure output remains visible normally.",
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
      return retainResult(result, `${label} succeeded.`, toolCallId);
    },
  });
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
