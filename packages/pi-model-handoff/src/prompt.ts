import { convertCurrency } from "@pi-extensions/lib";
import type { HandoffEstimate, ModelRef } from "./decision.ts";

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

function formatConvertedCost(usd: number | undefined): string | undefined {
  if (usd === undefined) {
    return undefined;
  }
  const nzd = convertCurrency({ amount: usd, from: "USD", to: "NZD" });
  if (nzd === undefined) {
    return undefined;
  }
  return `~$${nzd.toFixed(2)}`;
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
  const cost = formatConvertedCost(estimate.targetFullContextInputCost);
  if (cost !== undefined) {
    msg += ` (${cost})`;
  }
  msg += ` · /handoff (~${formatTokens(estimate.estimatedHandoffTokens)})`;
  return msg;
}
