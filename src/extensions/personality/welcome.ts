import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  collectPersonalityContext,
  compactRelativeTime,
  type PersonalityContext,
} from "./context.js";

export type WelcomeTimeBand = "morning" | "afternoon" | "evening";

type WelcomeIdentity = {
  greeting: string;
  mascot: string;
  subline: string;
};

type WelcomeHeader = {
  render(width: number): string[];
  invalidate(): void;
};

const FALLBACK_SUBLINES = [
  "Ready when you are.",
  "What are we making today?",
  "Let’s make something good.",
];

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
  context: Pick<PersonalityContext, "recentSessions" | "changedFileCount"> = {
    recentSessions: [],
    changedFileCount: 0,
  },
  seed = "session",
): string {
  const name = nickname ? `, ${nickname}` : "";
  const returning = context.recentSessions.length > 0;
  const dirty = context.changedFileCount > 0;
  const choices = returning
    ? [
        `Welcome back${name}.`,
        `Here we are again${name}.`,
        `Back at it${name}.`,
      ]
    : dirty
      ? [`Ready when you are${name}.`, `Hey there${name}.`, `All set${name}.`]
      : timeBand === "morning"
        ? [`Good morning${name}.`, `Morning${name}.`, `Hey there${name}.`]
        : timeBand === "afternoon"
          ? [`Good afternoon${name}.`, `Hey there${name}.`, `Afternoon${name}.`]
          : [`Good evening${name}.`, `Evening${name}.`, `Hey there${name}.`];
  return choices[
    choose(seed, `${timeBand}:${returning}:${dirty}`, choices.length)
  ]!;
}

export function buildWelcomeIdentity(
  nickname: string | undefined,
  timeBand: WelcomeTimeBand,
  context: PersonalityContext,
  seed: string,
  now = Date.now(),
): WelcomeIdentity {
  const greeting = buildWelcomeGreeting(nickname, timeBand, context, seed);
  const subline = welcomeSubline(context, seed, now);
  return {
    greeting,
    subline,
    mascot:
      context.changedFileCount > 0
        ? "(•̀ᴗ•́)"
        : context.recentSessions.length > 0
          ? "(¬ᴗ¬)"
          : "(•ᴗ•)",
  };
}

export function welcomeSubline(
  context: PersonalityContext,
  seed: string,
  now = Date.now(),
): string {
  if (context.changedFileCount > 0) {
    const count = context.changedFileCount;
    const files = `${count} changed file${count === 1 ? "" : "s"}`;
    const choices = [
      `We left ${count} file${count === 1 ? "" : "s"} in flight.`,
      `There ${count === 1 ? "is" : "are"} ${count} loose end${count === 1 ? "" : "s"} waiting.`,
      `Picking up with ${files}.`,
    ];
    return choices[choose(seed, "dirty", choices.length)]!;
  }
  const previous = context.recentSessions[0];
  if (previous) {
    const choices = ["Last time", "Picking up from", "Previously"];
    return `${choices[choose(seed, "session", choices.length)]!}: “${previous.title}” · ${compactRelativeTime(previous.modified, now)}`;
  }
  const commit = context.recentCommits[0];
  if (commit) {
    const choices = ["Fresh off", "Latest"];
    return `${choices[choose(seed, "commit", choices.length)]!}: “${commit.subject}” · ${compactRelativeTime(commit.timestamp, now)}`;
  }
  return FALLBACK_SUBLINES[choose(seed, "fallback", FALLBACK_SUBLINES.length)]!;
}

export function welcomeLines(
  greeting: string,
  _cwd: string,
  width: number,
  theme: Theme,
): string[] {
  return new WelcomeCard(
    { greeting, mascot: "(•ᴗ•)", subline: "Ready when you are." },
    theme,
  ).render(width);
}

export class WelcomeCard implements WelcomeHeader {
  constructor(
    private readonly identity: WelcomeIdentity,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const available = Math.max(1, width);
    if (available < 12) {
      return [truncateToWidth(this.identity.greeting, available)];
    }
    const cardWidth = Math.min(available, 64);
    const innerWidth = cardWidth - 2;
    const title = " Pipkin ";
    const top = `╭─${title}${"─".repeat(Math.max(0, innerWidth - visibleWidth(title) - 1))}╮`;
    const bottom = `╰${"─".repeat(Math.max(0, innerWidth))}╯`;
    const mascotPrefix = `  ${this.identity.mascot}  `;
    const greeting = truncateToWidth(
      this.identity.greeting,
      Math.max(0, innerWidth - visibleWidth(mascotPrefix)),
    );
    const subline = truncateToWidth(
      this.identity.subline,
      Math.max(0, innerWidth - visibleWidth(mascotPrefix)),
    );
    const style = this.theme;
    return [
      style.fg("border", top),
      `${style.fg("border", "│")}${style.fg("accent", mascotPrefix)}${style.fg("text", pad(greeting, innerWidth - visibleWidth(mascotPrefix)))}${style.fg("border", "│")}`,
      `${style.fg("border", "│")}${" ".repeat(visibleWidth(mascotPrefix))}${style.fg("muted", pad(subline, innerWidth - visibleWidth(mascotPrefix)))}${style.fg("border", "│")}`,
      style.fg("border", bottom),
    ].map((line) => truncateToWidth(line, available, "", false));
  }

  invalidate(): void {
    // Render creates themed strings from the current factory theme and retains none.
  }
}

export function registerWelcome(
  pi: ExtensionAPI,
  nickname: string | undefined,
): void {
  let current: ExtensionContext | undefined;
  let shown = false;
  let retainedHeader = false;
  let shownInFullscreen = false;
  let generation = 0;
  let contextAbortController: AbortController | undefined;

  const clear = (retainFullscreen = false) => {
    generation++;
    contextAbortController?.abort();
    contextAbortController = undefined;
    if (!shown && !retainedHeader) {
      return;
    }
    const retain = retainFullscreen && shownInFullscreen;
    shown = false;
    if (retain) {
      retainedHeader = true;
      return;
    }
    current?.ui.setHeader(undefined);
    retainedHeader = false;
    shownInFullscreen = false;
    current = undefined;
  };

  pi.on(
    "session_start",
    async (event: SessionStartEvent, ctx: ExtensionContext) => {
      clear();
      if (
        ctx.mode !== "tui" ||
        !["startup", "new"].includes(event.reason) ||
        hasConversationHistory(ctx.sessionManager.getBranch())
      ) {
        return;
      }
      const currentGeneration = generation;
      const abortController = new AbortController();
      contextAbortController = abortController;
      const context = await collectPersonalityContext(
        ctx,
        abortController.signal,
      );
      if (
        abortController.signal.aborted ||
        currentGeneration !== generation ||
        contextAbortController !== abortController
      ) {
        return;
      }
      contextAbortController = undefined;
      const identity = buildWelcomeIdentity(
        nickname,
        welcomeTimeBand(new Date().getHours()),
        context,
        ctx.sessionManager.getSessionId?.() ?? "session",
      );
      current = ctx;
      shown = true;
      retainedHeader = false;
      ctx.ui.setHeader((tui, theme): WelcomeHeader => {
        shownInFullscreen = tui?.mode === "fullscreen";
        return new WelcomeCard(identity, theme);
      });
    },
  );

  pi.on("input", (event, _ctx) => {
    if (event.text.trim() || event.images?.length) {
      clear(true);
    }
  });
  pi.on("session_info_changed", () => clear());
  pi.on("session_shutdown", () => clear());
}

function choose(seed: string, category: string, count: number): number {
  let value = 0;
  for (const character of `${seed}:${category}`) {
    value = (value * 31 + character.codePointAt(0)!) >>> 0;
  }
  return value % count;
}

function pad(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
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
