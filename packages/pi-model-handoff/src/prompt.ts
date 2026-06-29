import type { HandoffEstimate, ModelRef } from "./decision.ts";

export const HANDOFF_INSTRUCTIONS =
  `Create a model-handoff summary for continuing this session with another model. ` +
  `Preserve the user's goal, constraints and preferences, concrete decisions made ` +
  `(with rationale), exact file paths, symbols and function names, commands or ` +
  `tests used, dead ends encountered, current blockers, open questions, and any ` +
  `known remaining work without assuming the next model should follow a fixed set ` +
  `of steps. Be concise but do not omit technical details needed to continue work.`;

function roundTo2SigFigs(n: number): number {
  if (n === 0) {
    return 0;
  }
  const d = Math.ceil(Math.log10(n));
  const power = Math.pow(10, d - 2);
  return Math.round(n / power) * power;
}

export function formatCost(usd: number | undefined): string | undefined {
  if (usd === undefined) {
    return undefined;
  }
  return `~$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
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

export function formatSwitchNotification(
  targetRef: ModelRef,
  estimate: HandoffEstimate,
): string {
  const targetName = targetRef.name ?? `${targetRef.provider}/${targetRef.id}`;
  let msg = `Switched to ${targetName} · ${formatTokens(estimate.currentTokens)} context`;
  const cost = formatCost(estimate.targetFullContextInputCost);
  if (cost !== undefined) {
    msg += ` (${cost})`;
  }
  msg += ` · /handoff (~${formatTokens(estimate.estimatedHandoffTokens)})`;
  return msg;
}
