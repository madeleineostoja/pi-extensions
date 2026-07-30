import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PapercutProposal } from "./store.js";
import { createPapercutStatusController } from "./status.js";

export const PapercutProposalSchema = Type.Object({
  key: Type.String({
    description:
      "Stable lowercase slug, e.g. ruby-validation-requires-devcontainer",
  }),
  title: Type.String({ description: "Concrete concise title" }),
  trigger: Type.String({
    description: "What reliably exposes this project-specific gap",
  }),
  impact: Type.String({
    description: "Why this will matter to a future independent session",
  }),
  currentGap: Type.String({
    description:
      "What instructions, tests, tooling, errors, or docs currently fail to prevent or explain",
  }),
  proposedResolution: Type.String({
    description:
      "Concrete durable human-reviewed remedy; this tool never applies it",
  }),
  suggestedDestination: Type.Union([
    Type.Literal("agents"),
    Type.Literal("skill"),
    Type.Literal("test"),
    Type.Literal("lint"),
    Type.Literal("tooling"),
    Type.Literal("docs"),
    Type.Literal("code"),
  ]),
});

const TOOL_DESCRIPTION = `Propose a durable, human-reviewed papercut for a recurring project-specific failure mode or hidden operational constraint. Use only when the lesson is likely to matter in an independent future session, is specific enough for a concrete resolution, current instructions/tests/tooling/errors/docs did not adequately prevent or explain it, and there is a plausible durable resolution. Do not use for expected intermediate failures during an intentionally incomplete multi-step edit; tests correctly detecting the current bug; typos, malformed calls, transient provider failures, unavailable services; ordinary self-corrected failed approaches; one-off task context; or failures correctly anticipated and handled by existing guidance. In particular, a correctly handled devcontainer failure is not a papercut unless that guidance has a demonstrated gap. This records personal checkout metadata only and never edits the suggested destination or project source.`;

type PapercutStatusController = ReturnType<
  typeof createPapercutStatusController
>;

export function registerProposalTool(
  pi: ExtensionAPI,
  status: PapercutStatusController,
): void {
  pi.registerTool({
    name: "propose_papercut",
    label: "propose_papercut",
    description: TOOL_DESCRIPTION,
    promptSnippet:
      "propose_papercut — record an eligible recurring project-specific gap for human review",
    parameters: PapercutProposalSchema,
    async execute(_id, proposal: PapercutProposal, _signal, _update, ctx) {
      const generation = status.generation();
      try {
        const result = await (
          await status.storeFor(ctx)
        ).propose(proposal, { kind: "agent" });
        await status.refreshStatus(ctx, generation);
        const text =
          result.kind === "rejected"
            ? `Papercut rejected: ${result.reason}`
            : result.kind === "created"
              ? `Papercut created: ${result.record.key}`
              : result.kind === "merged"
                ? `Papercut merged into pending: ${result.record.key}`
                : result.kind === "ignored"
                  ? `Papercut already ignored: ${result.record.key}`
                  : `Papercut already resolved: ${result.record.key}`;
        if (result.kind === "created") {
          ctx.ui.notify(`Papercut added: ${result.record.title}`, "info");
        }
        return { content: [{ type: "text" as const, text }], details: result };
      } catch (error) {
        const text = `Papercut rejected: ${error instanceof Error ? error.message : String(error)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { kind: "rejected", reason: text },
        };
      }
    },
  });
}
