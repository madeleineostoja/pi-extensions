import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  compactDisplayText,
  toolResultRenderer,
} from "#lib/ui/tool-result-renderer";
import { Type } from "typebox";
import type { PapercutObservation } from "./store.js";
import { createPapercutStatusController } from "./status.js";

const destination = Type.Union(
  [
    Type.Literal("agents"),
    Type.Literal("skill"),
    Type.Literal("test"),
    Type.Literal("lint"),
    Type.Literal("tooling"),
    Type.Literal("docs"),
    Type.Literal("code"),
  ],
  {
    description:
      "Optional repository area most likely to own a future guardrail.",
  },
);

function prose(maxLength: number, description: string) {
  return Type.String({ minLength: 1, maxLength, pattern: "\\S", description });
}

export const PapercutObservationSchema = Type.Object(
  {
    key: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
      description: "Stable lowercase registry key, one to 64 characters.",
    }),
    title: prose(120, "Concise title identifying the recurring friction."),
    task: prose(
      1_000,
      "Assigned subject being completed when the unrelated friction occurred.",
    ),
    incident: prose(
      2_000,
      "Factual account of the avoidable friction encountered.",
    ),
    evidence: prose(
      2_000,
      "Concrete observed evidence that the friction occurred.",
    ),
    workarounds: Type.Array(
      prose(
        1_000,
        "One workaround or detour actually exercised while continuing safely.",
      ),
      {
        minItems: 1,
        maxItems: 5,
        description: "One to five workarounds actually used, not suggestions.",
      },
    ),
    taskOutcome: prose(
      1_000,
      "How the assigned task completed or safely continued after the workaround.",
    ),
    guardrailCandidate: Type.Optional(
      prose(
        1_000,
        "Optional concrete guardrail that could prevent the friction.",
      ),
    ),
    suggestedDestination: Type.Optional(destination),
  },
  { additionalProperties: false },
);

const TOOL_DESCRIPTION = `Record factual incidental friction only when all of these are true: while completing an assigned subject that was something else, you concretely encountered avoidable friction, actually exercised at least one workaround or detour, and then completed or safely continued the task. No outage, exception, failed command or run, or user-visible failure is required. Examples: recover from a flaky documented test with a narrower command; discover an undocumented validation convention and use it; or perform an avoidable manual worktree setup sequence and safely continue. Qualifying friction includes context reconstruction or ambiguous output. Each workaround is an action actually taken, not a suggestion.

Do not record the current task subject, a review finding or unmet requirement, unresolved correctness or safety issues, inferred architecture, unused suggestions, expected proportionate guided steps, adequately documented proportionate procedures, one-off agent mistakes, typos, malformed commands, or transient service/provider failures. This trusted-agent instruction is not runtime classification. Records are candidates for repository guidance or small fixes; this tool only writes personal registry metadata.`;

type PapercutStatusController = ReturnType<
  typeof createPapercutStatusController
>;

function resultText(
  kind: "created" | "merged" | "reopened",
  key: string,
  occurrences: number,
): string {
  return `Papercut ${kind}: ${key} (${occurrences})`;
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return (
    content.find(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )?.text ?? ""
  );
}

function rejection(): {
  content: Array<{ type: "text"; text: string }>;
  details: { kind: "rejected" };
} {
  return {
    content: [{ type: "text", text: "Papercut rejected." }],
    details: { kind: "rejected" },
  };
}

export function registerRecordTool(
  pi: ExtensionAPI,
  status: PapercutStatusController,
): void {
  pi.registerTool({
    name: "record_papercut",
    label: "record_papercut",
    description: TOOL_DESCRIPTION,
    parameters: PapercutObservationSchema,
    renderResult: toolResultRenderer({
      summary(result) {
        const details = result.details as
          | { outcome?: string; key?: string; title?: string; kind?: string }
          | undefined;
        if (details?.kind === "rejected") {
          return "Papercut was not recorded.";
        }
        const key = compactDisplayText(details?.key, 64) || "papercut";
        const title = compactDisplayText(details?.title, 120);
        const outcome = compactDisplayText(details?.outcome, 80);
        return [
          `Recorded ${key}${title ? ` · ${title}` : ""}.`,
          ...(outcome ? [`Outcome: ${outcome}.`] : []),
        ];
      },
      partial() {
        return "Recording papercut…";
      },
      error(result) {
        return (
          firstText(result.content).split("\n", 1)[0] ||
          "Papercut recording failed."
        );
      },
    }),
    async execute(
      _id,
      observation: PapercutObservation,
      _signal,
      _update,
      ctx,
    ) {
      try {
        const result = await (await status.storeFor(ctx)).record(observation);
        if (result.kind === "rejected") {
          return rejection();
        }
        await status.refreshStatus(ctx);
        const details = {
          outcome: result.kind,
          key: result.record.key,
          title: result.record.title,
          occurrences: result.record.occurrences,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: resultText(result.kind, details.key, details.occurrences),
            },
          ],
          details,
        };
      } catch {
        return rejection();
      }
    },
  });
}
