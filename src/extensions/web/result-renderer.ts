import { toolResultRenderer } from "#lib/ui/tool-result-renderer";

export const renderWebFetchResult = toolResultRenderer({
  summary(result) {
    const details = record(result.details);
    const target = targetLabel(details?.finalUrl ?? details?.requestedUrl);
    const output = text(details?.output);
    const contentType = text(details?.contentType);
    const characters = details?.contentChars;
    return [
      `Fetched ${target ?? "public target"}.`,
      [
        output,
        contentType,
        typeof characters === "number" ? `${characters} characters` : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" · "),
    ].filter(Boolean);
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
    return [
      "Batch web fetch.",
      typeof total === "number" && typeof succeeded === "number"
        ? `${succeeded} of ${total} targets fetched${typeof failed === "number" && failed > 0 ? ` · ${failed} failed` : ""}.`
        : "",
    ].filter(Boolean);
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

function targetLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}
