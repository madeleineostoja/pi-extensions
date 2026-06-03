import type { HandoffEstimate, ModelRef } from "./decision.ts";

export const OPTION_CREATE_HANDOFF = "Create handoff";
export const OPTION_CONTINUE_FULL_CONTEXT = "Continue full context";

export const HANDOFF_INSTRUCTIONS =
  `Create an implementation-focused summary that preserves the following: ` +
  `the user's goal, constraints and preferences, concrete decisions made ` +
  `(with rationale), exact file paths, symbols and function names, ` +
  `commands or tests used, dead ends encountered, current blockers, ` +
  `and the exact next steps the user asked for. ` +
  `Be concise but do not omit technical details needed to continue work.`;

export function formatHandoffPrompt(
  sourceRef: ModelRef,
  targetRef: ModelRef,
  estimate: HandoffEstimate,
): string {
  const sourceName = sourceRef.name ?? `${sourceRef.provider}/${sourceRef.id}`;
  const targetName = targetRef.name ?? `${targetRef.provider}/${targetRef.id}`;

  let prompt = `Model handoff: ${sourceName} → ${targetName}\n`;
  prompt += `Estimated current tokens: ${estimate.currentTokens.toLocaleString()}\n`;
  prompt += `Estimated summarized tokens: ${estimate.summarizedTokens.toLocaleString()}\n`;
  prompt += `Estimated kept tokens: ${estimate.keptTokens.toLocaleString()}`;

  if (estimate.sourceInputCost !== undefined) {
    prompt += `\nEstimated current cost (source): ~$${estimate.sourceInputCost.toFixed(4)}`;
  }
  if (estimate.targetFullContextInputCost !== undefined) {
    prompt += `\nEstimated full-context cost (target): ~$${estimate.targetFullContextInputCost.toFixed(4)}`;
  }
  if (estimate.targetKeptContextInputCost !== undefined) {
    prompt += `\nEstimated kept-context cost (target): ~$${estimate.targetKeptContextInputCost.toFixed(4)}`;
  }

  return prompt;
}
