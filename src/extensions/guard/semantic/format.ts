import type { Risk } from "./assessors.js";

const DETAIL_LIMIT = 16_384;
const TRUNCATION = "… detail truncated";

function excerpt(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : value.slice(0, limit - TRUNCATION.length) + TRUNCATION;
}

export function formatRisks(risks: Risk[]): string {
  const summaries = risks.map(
    (risk, index) => `${index + 1}. ${risk.category}: ${risk.effect}`,
  );
  const reserve = summaries.reduce(
    (size, summary) => size + summary.length + 3,
    0,
  );
  const available = Math.max(0, DETAIL_LIMIT - reserve);
  const perRisk = Math.floor(available / Math.max(risks.length, 1));
  return risks
    .map((risk, index) => {
      const detail = [
        risk.segment,
        risk.targets.length ? `Targets: ${risk.targets.join(", ")}` : "",
        risk.uncertainty ?? "",
      ]
        .filter(Boolean)
        .join("\n");
      return perRisk
        ? `${summaries[index]}\n${excerpt(detail, perRisk)}`
        : summaries[index]!;
    })
    .join("\n\n");
}
