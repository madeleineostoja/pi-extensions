import type { RuntimeSnapshot } from "./runtime.js";

export function elapsedLabel(
  snapshot: Pick<RuntimeSnapshot, "timestamps">,
  currentTime = Date.now(),
): string {
  const start = Date.parse(
    snapshot.timestamps.startedAt ?? snapshot.timestamps.queuedAt,
  );
  const end = Date.parse(
    snapshot.timestamps.completedAt ?? new Date(currentTime).toISOString(),
  );
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return "unknown";
  }
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toString().padStart(2, "0")}s`;
}

export function costLabel(value: number | undefined): string {
  return value === undefined ? "-" : `$${value.toFixed(2)}`;
}

export function tokenLabel(value: number | undefined): string {
  if (value === undefined) {
    return "-";
  }
  const rounded = roundToTwoSignificantFigures(value);
  if (rounded < 1000) {
    return String(rounded);
  }
  if (rounded < 1_000_000) {
    return compactTokenLabel(rounded / 1000, "k");
  }
  return compactTokenLabel(rounded / 1_000_000, "M");
}

function roundToTwoSignificantFigures(value: number): number {
  if (value === 0) {
    return 0;
  }
  const power = 10 ** (Math.ceil(Math.log10(Math.abs(value))) - 2);
  return Math.round(value / power) * power;
}

function compactTokenLabel(value: number, suffix: string): string {
  return `${value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "")}${suffix}`;
}
