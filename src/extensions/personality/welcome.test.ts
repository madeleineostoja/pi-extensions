import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PersonalityContext } from "./context.js";
import {
  buildWelcomeGreeting,
  buildWelcomeIdentity,
  registerWelcome,
  WelcomeCard,
  welcomeSubline,
  welcomeTimeBand,
} from "./welcome.js";

function fixture(nickname = "Mads", branch: unknown[] = []) {
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const setHeader = vi.fn();
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: { on: vi.fn(() => () => {}) },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    cwd: "/work/pipkin",
    sessionManager: { getBranch: () => [], getSessionId: () => "current" },
    ui: { setHeader },
  } as unknown as ExtensionContext;
  (ctx.sessionManager.getBranch as any) = () => branch;
  registerWelcome(pi, nickname);
  return { handlers, ctx, setHeader };
}

function sessionStart(
  handlers: Map<string, ((event: any, ctx: any) => unknown)[]>,
  reason: SessionStartEvent["reason"],
  ctx: ExtensionContext,
) {
  const handler = handlers.get("session_start")?.[0];
  if (!handler) {
    throw new Error("session_start handler was not registered");
  }
  return handler({ reason }, ctx);
}

const theme = { fg: (_tone: string, text: string) => text } as Theme;
const plainContext: PersonalityContext = {
  branch: undefined,
  changedFileCount: 0,
  changedAreas: [],
  recentSessions: [],
  recentCommits: [],
};

describe("Welcome", () => {
  it("selects a stable greeting by session identity, not nickname length", () => {
    expect(buildWelcomeGreeting("Mads", "morning", plainContext, "a")).toBe(
      buildWelcomeGreeting("Ada", "morning", plainContext, "a").replace(
        ", Ada",
        ", Mads",
      ),
    );
    expect(welcomeTimeBand(0)).toBe("morning");
    expect(welcomeTimeBand(12)).toBe("afternoon");
    expect(welcomeTimeBand(18)).toBe("evening");
  });

  it("uses only supported continuity and one prioritized subline category", () => {
    const returning = {
      ...plainContext,
      recentSessions: [
        { title: "Personality UI polish", modified: new Date("2026-01-01") },
      ],
    };
    const dirty = { ...returning, changedFileCount: 4 };
    expect(
      buildWelcomeGreeting("Mads", "evening", plainContext, "a"),
    ).not.toMatch(/back|again/i);
    expect(buildWelcomeGreeting("Mads", "evening", returning, "a")).toMatch(
      /back|again|at it/i,
    );
    expect(welcomeSubline(dirty, "a", Date.parse("2026-01-02"))).toMatch(
      /4 (files|loose ends)|4 changed files/i,
    );
    expect(welcomeSubline(returning, "a", Date.parse("2026-01-02"))).toContain(
      "Personality UI polish",
    );
  });

  it("renders a compact themed card with a mascot and width-safe lines", () => {
    const identity = buildWelcomeIdentity(
      "Mads",
      "morning",
      plainContext,
      "session",
    );
    const card = new WelcomeCard(identity, theme);
    const lines = card.render(48);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("(•ᴗ•)");
    expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
    expect(card.render(8).every((line) => visibleWidth(line) <= 8)).toBe(true);
  });

  it("shows one complete card only for empty fresh TUI sessions and clears idempotently", async () => {
    const { handlers, ctx, setHeader } = fixture();
    await sessionStart(handlers, "startup", ctx);
    expect(setHeader).toHaveBeenCalledTimes(1);
    const header = setHeader.mock.calls[0]?.[0](undefined, theme);
    expect(header.render(80)[0]).toContain("Pipkin");

    const input = handlers.get("input")?.[0];
    input?.({ text: "Start work" }, ctx);
    input?.({ text: "Later" }, ctx);
    expect(setHeader).toHaveBeenLastCalledWith(undefined);
    expect(setHeader).toHaveBeenCalledTimes(2);

    for (const reason of ["reload", "resume", "fork"] as const) {
      const fresh = fixture();
      await sessionStart(fresh.handlers, reason, fresh.ctx);
      expect(fresh.setHeader).not.toHaveBeenCalled();
    }
    const withHistory = fixture("Mads", [
      { type: "message", message: { role: "user" } },
    ]);
    await sessionStart(withHistory.handlers, "startup", withHistory.ctx);
    expect(withHistory.setHeader).not.toHaveBeenCalled();
  });
});
