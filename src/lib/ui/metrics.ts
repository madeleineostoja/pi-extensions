export function formatCompactTokens(n: number): string {
  if (n < 1000) {
    return n.toString();
  }
  if (n < 10000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  if (n < 1000000) {
    return `${Math.round(n / 1000)}k`;
  }
  if (n < 10000000) {
    return `${(n / 1000000).toFixed(1)}M`;
  }
  return `${Math.round(n / 1000000)}M`;
}

export function formatUsdCost(cost: number): string {
  const cents = Math.round(cost * 100);
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `$${dollars}.${remainder.toString().padStart(2, "0")}`;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatProgress(completed: number, total: number): string {
  return `${completed}/${total}`;
}
