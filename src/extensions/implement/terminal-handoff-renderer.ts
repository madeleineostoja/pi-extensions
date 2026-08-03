import {
  getMarkdownTheme,
  type EntryRenderer,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import type { RunState } from "./store.js";

export const TERMINAL_HANDOFF_ENTRY_TYPE = "pipkin.implement.terminal-handoff";

export type TerminalHandoffEntry = {
  phase: Extract<RunState["phase"], "completed" | "incomplete" | "failed">;
  runId: string;
  text: string;
};

export const renderTerminalHandoffEntry: EntryRenderer<TerminalHandoffEntry> = (
  entry,
  _options,
  theme,
) => {
  if (!isTerminalHandoffEntry(entry.data)) {
    return undefined;
  }
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(
    new Text(
      theme.fg("accent", `Implement handoff · ${phaseLabel(entry.data.phase)}`),
      0,
      0,
    ),
  );
  box.addChild(new Markdown(entry.data.text, 0, 0, getMarkdownTheme()));
  return box;
};

function isTerminalHandoffEntry(value: unknown): value is TerminalHandoffEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Partial<TerminalHandoffEntry>;
  return (
    ["completed", "incomplete", "failed"].includes(entry.phase ?? "") &&
    typeof entry.runId === "string" &&
    entry.runId.length > 0 &&
    typeof entry.text === "string" &&
    entry.text.length > 0
  );
}

function phaseLabel(phase: TerminalHandoffEntry["phase"]): string {
  switch (phase) {
    case "completed":
      return "Completed";
    case "incomplete":
      return "Incomplete";
    case "failed":
      return "Failed";
  }
}
