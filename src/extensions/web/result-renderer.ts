import { toolResultRenderer } from "#lib/ui/tool-result-renderer";

export const renderWebFetchResult = toolResultRenderer({
  summary(result) {
    const details = record(result.details);
    const output = text(details?.output);
    const contentType = text(details?.contentType);
    const characters = details?.contentChars;
    return [
      output,
      contentType,
      typeof characters === "number" ? `${characters} characters` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" · ");
  },
  partial(result) {
    const details = record(result.details);
    const phase = text(details?.phase);
    return phase ? `Web Fetch · ${phase}.` : "Fetching public target…";
  },
  error(result) {
    return firstText(result.content).split("\n", 1)[0] || "Web Fetch failed.";
  },
  content: "markdown",
});

export const renderBatchWebFetchResult = toolResultRenderer({
  summary(result) {
    const details = record(result.details);
    const total = details?.total;
    const succeeded = details?.succeeded;
    const failed = details?.failed;
    return typeof total === "number" && typeof succeeded === "number"
      ? `${succeeded}/${total} fetched${typeof failed === "number" && failed > 0 ? ` · ${failed} failed` : ""}`
      : undefined;
  },
  partial(result) {
    const details = record(result.details);
    const ordinal = details?.ordinal;
    const total = details?.total;
    const phase = text(details?.phase) ?? text(details?.status);
    return typeof ordinal === "number" && typeof total === "number"
      ? `Batch target ${ordinal}/${total}${phase ? ` · ${phase}` : ""}.`
      : "Preparing web requests…";
  },
  error(result) {
    return (
      firstText(result.content).split("\n", 1)[0] || "Batch Web Fetch failed."
    );
  },
  content: "markdown",
});

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
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
