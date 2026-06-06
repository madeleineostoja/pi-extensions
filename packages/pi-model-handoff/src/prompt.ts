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

function roundTo2SigFigs(n: number): number {
  if (n === 0) {
    return 0;
  }
  const d = Math.ceil(Math.log10(n));
  const power = Math.pow(10, d - 2);
  return Math.round(n / power) * power;
}

function formatTokens(n: number): string {
  const rounded = roundTo2SigFigs(n);
  if (rounded >= 1000) {
    const k = rounded / 1000;
    if (k >= 10) {
      return `${Math.round(k)}k`;
    }
    return `${k.toFixed(1)}k`;
  }
  return String(rounded);
}

export function formatHandoffPrompt(
  sourceRef: ModelRef,
  targetRef: ModelRef,
  estimate: HandoffEstimate,
): string {
  const sourceName = sourceRef.name ?? `${sourceRef.provider}/${sourceRef.id}`;
  const targetName = targetRef.name ?? `${targetRef.provider}/${targetRef.id}`;

  let prompt = `Model handoff: ${sourceName} -> ${targetName}\n`;
  prompt += `- Full context: ~${formatTokens(estimate.currentTokens)}`;
  if (estimate.targetFullContextInputCost !== undefined) {
    prompt += ` (~$${estimate.targetFullContextInputCost.toFixed(4)})`;
  }
  prompt += `\n`;

  prompt += `- Estimated handoff context: ~${formatTokens(estimate.estimatedHandoffTokens)}`;
  if (estimate.estimatedHandoffCost !== undefined) {
    prompt += ` (~$${estimate.estimatedHandoffCost.toFixed(4)})`;
  }
  prompt += `\n`;

  prompt += `- Estimated savings: ~${formatTokens(estimate.estimatedSavingsTokens)}`;
  if (estimate.estimatedSavingsCost !== undefined) {
    prompt += ` (~$${estimate.estimatedSavingsCost.toFixed(4)})`;
  }

  return prompt;
}
