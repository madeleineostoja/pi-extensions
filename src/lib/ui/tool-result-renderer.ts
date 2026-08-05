import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import {
  Container,
  Markdown,
  Text,
  type Component,
} from "@earendil-works/pi-tui";

type TextBlock = { type: "text"; text: string };
type ResultLike = { content: unknown; details?: unknown };
type RenderOptions = { expanded: boolean; isPartial: boolean };
type RenderContext = { isError?: boolean; args?: unknown };
type Summary = string | readonly string[] | undefined;

type RendererOptions = {
  summary: (result: ResultLike, context: RenderContext) => Summary;
  partial?: (result: ResultLike, context: RenderContext) => Summary;
  error?: (result: ResultLike, context: RenderContext) => Summary;
  content?: "text" | "markdown";
  expandedDetails?: (result: ResultLike, context: RenderContext) => Summary;
  expandedCompleteDetails?: (
    result: ResultLike,
    context: RenderContext,
  ) => Summary;
  expandedContent?: (result: ResultLike, context: RenderContext) => unknown;
};

/**
 * Composes feature-owned semantic summaries with complete model-facing text.
 * Image blocks remain Pi's responsibility and are intentionally not reproduced.
 */
export function toolResultRenderer(options: RendererOptions) {
  return function renderResult(
    result: ResultLike & { isError?: boolean },
    renderOptions: RenderOptions,
    theme: Theme,
    context: RenderContext = {},
  ): Component {
    const renderContext = {
      ...context,
      isError: context.isError ?? result.isError,
    };
    const state = renderContext.isError
      ? options.error
      : renderOptions.isPartial
        ? options.partial
        : options.summary;
    const lines = summaryLines(
      state?.(result, renderContext) ??
        (renderContext.isError
          ? "Failed."
          : renderOptions.isPartial
            ? "Working…"
            : undefined),
    );
    if (!renderOptions.expanded) {
      return new Text(
        theme.fg(tone(renderContext, renderOptions), lines.join("\n")),
        0,
        0,
      );
    }

    const view = new Container();
    if (lines.length > 0) {
      view.addChild(
        new Text(
          theme.fg(tone(renderContext, renderOptions), lines.join("\n")),
          0,
          0,
        ),
      );
    }
    for (const detail of expandedDetailLines(
      options.expandedDetails?.(result, renderContext),
    )) {
      view.addChild(new Text(theme.fg("dim", detail), 0, 0));
    }
    for (const detail of completeDetailLines(
      options.expandedCompleteDetails?.(result, renderContext),
    )) {
      view.addChild(new Text(theme.fg("dim", detail), 0, 0));
    }
    for (const block of textBlocks(
      options.expandedContent?.(result, renderContext) ?? result.content,
    )) {
      view.addChild(
        options.content === "markdown"
          ? new Markdown(block.text, 0, 0, getMarkdownTheme())
          : new Text(theme.fg("toolOutput", block.text), 0, 0),
      );
    }
    return view;
  };
}

const MAX_SUMMARY_LINES = 3;
const MAX_SUMMARY_CHARS = 240;

/** Normalizes untrusted text before it is used in a compact result summary. */
export function compactDisplayText(
  value: unknown,
  maximum = MAX_SUMMARY_CHARS,
): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = Array.from(
    stripVTControlCharacters(value),
    (character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? " "
        : character;
    },
  )
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(normalized);
  return characters.length <= maximum
    ? normalized
    : `${characters.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function summaryLines(summary: Summary): string[] {
  return displayLines(summary).slice(0, MAX_SUMMARY_LINES);
}

function expandedDetailLines(details: Summary): string[] {
  return displayLines(details);
}

function displayLines(value: Summary): string[] {
  if (value === undefined) {
    return [];
  }
  return (typeof value === "string" ? [value] : [...value])
    .map((line) => compactDisplayText(line))
    .filter(Boolean);
}

function completeDetailLines(details: Summary): string[] {
  if (details === undefined) {
    return [];
  }
  return (typeof details === "string" ? [details] : [...details]).filter(
    Boolean,
  );
}

function textBlocks(content: unknown): TextBlock[] {
  return Array.isArray(content)
    ? content.filter(
        (block): block is TextBlock =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
    : [];
}

function tone(
  context: RenderContext,
  options: RenderOptions,
): "error" | "warning" | "success" {
  return context.isError ? "error" : options.isPartial ? "warning" : "success";
}
