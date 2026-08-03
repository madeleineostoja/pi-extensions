import { basename } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export type WelcomeTimeBand = "morning" | "afternoon" | "evening";

type WelcomeHeader = {
  render(width: number): string[];
  invalidate(): void;
};

const GREETINGS: Record<WelcomeTimeBand, readonly [string, string]> = {
  morning: ["Good morning", "Morning"],
  afternoon: ["Good afternoon", "Hello"],
  evening: ["Good evening", "Hello"],
};

export function welcomeTimeBand(hour: number): WelcomeTimeBand {
  if (hour < 12) {
    return "morning";
  }
  if (hour < 18) {
    return "afternoon";
  }
  return "evening";
}

export function buildWelcomeGreeting(
  nickname: string | undefined,
  timeBand: WelcomeTimeBand,
): string {
  const choices = GREETINGS[timeBand];
  if (!nickname) {
    return `${choices[0]}.`;
  }
  const choice = choices[Array.from(nickname).length % choices.length];
  return `${choice}, ${nickname}.`;
}

export function welcomeLines(
  greeting: string,
  cwd: string,
  width: number,
  theme: Theme,
): string[] {
  const available = Math.max(1, width);
  const workspace = basename(cwd) || cwd;
  return [
    truncateToWidth(greeting, available),
    truncateToWidth(theme.fg("muted", workspace), available),
  ];
}

export function registerWelcome(
  pi: ExtensionAPI,
  nickname: string | undefined,
): void {
  let current: ExtensionContext | undefined;
  let shown = false;

  const clear = () => {
    if (!shown) {
      return;
    }
    shown = false;
    current?.ui.setHeader(undefined);
    current = undefined;
  };

  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
    clear();
    if (
      ctx.mode !== "tui" ||
      !["startup", "new"].includes(event.reason) ||
      hasConversationHistory(ctx.sessionManager.getBranch())
    ) {
      return;
    }
    const greeting = buildWelcomeGreeting(
      nickname,
      welcomeTimeBand(new Date().getHours()),
    );
    current = ctx;
    shown = true;
    ctx.ui.setHeader(
      (_tui, theme): WelcomeHeader => ({
        render: (width) => welcomeLines(greeting, ctx.cwd, width, theme),
        invalidate: () => {},
      }),
    );
  });

  pi.on("input", (event, _ctx) => {
    if (event.text.trim() || event.images?.length) {
      clear();
    }
  });
  pi.on("session_shutdown", clear);
}

function hasConversationHistory(entries: readonly unknown[]): boolean {
  return entries.some(
    (entry) =>
      isRecord(entry) &&
      entry.type === "message" &&
      isRecord(entry.message) &&
      (entry.message.role === "user" || entry.message.role === "assistant"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
