import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildWelcomeGreeting,
  registerWelcome,
  welcomeLines,
  welcomeTimeBand,
} from "./welcome.js";

function fixture(nickname = "Mads", branch: unknown[] = []) {
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const setHeader = vi.fn();
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    cwd: "/work/pipkin",
    sessionManager: { getBranch: () => branch },
    ui: { setHeader },
  } as unknown as ExtensionContext;
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
  handler({ reason }, ctx);
}

const theme = {
  fg: (_tone: string, text: string) => text,
} as Theme;

describe("Welcome", () => {
  it("selects a deterministic natural greeting", () => {
    expect(buildWelcomeGreeting("Mads", "morning")).toBe(
      buildWelcomeGreeting("Mads", "morning"),
    );
    expect(buildWelcomeGreeting(undefined, "evening")).toBe("Good evening.");
    expect(welcomeTimeBand(0)).toBe("morning");
    expect(welcomeTimeBand(12)).toBe("afternoon");
    expect(welcomeTimeBand(18)).toBe("evening");
  });

  it("shows two plain, width-safe lines only for empty fresh sessions", () => {
    const { handlers, ctx, setHeader } = fixture();
    sessionStart(handlers, "startup", ctx);

    const header = setHeader.mock.calls[0][0](undefined, theme);
    const narrow = header.render(8);
    expect(narrow).toHaveLength(2);
    expect(visibleWidth(narrow[0])).toBeLessThanOrEqual(8);
    expect(narrow[1]).toBe("pipkin");
    expect(header.render(80)).toEqual([
      expect.stringMatching(/, Mads\.$/),
      "pipkin",
    ]);

    for (const reason of ["reload", "resume", "fork"] as const) {
      const fresh = fixture();
      sessionStart(fresh.handlers, reason, fresh.ctx);
      expect(fresh.setHeader).not.toHaveBeenCalled();
    }
    const withHistory = fixture("Mads", [
      { type: "message", message: { role: "user" } },
    ]);
    sessionStart(withHistory.handlers, "startup", withHistory.ctx);
    expect(withHistory.setHeader).not.toHaveBeenCalled();
  });

  it("also shows on new sessions and clears before the first accepted input", () => {
    const { handlers, ctx, setHeader } = fixture();
    sessionStart(handlers, "new", ctx);
    const input = handlers.get("input")?.[0];
    if (!input) {
      throw new Error("input handler was not registered");
    }

    input({ text: "", images: [] }, ctx);
    expect(setHeader).toHaveBeenCalledTimes(1);
    input({ text: "Start work" }, ctx);
    input({ text: "Later input" }, ctx);

    expect(setHeader).toHaveBeenLastCalledWith(undefined);
    expect(setHeader).toHaveBeenCalledTimes(2);
  });

  it("clears the header idempotently on shutdown", () => {
    const { handlers, ctx, setHeader } = fixture();
    sessionStart(handlers, "startup", ctx);
    const shutdown = handlers.get("session_shutdown")?.[0];
    if (!shutdown) {
      throw new Error("session_shutdown handler was not registered");
    }

    shutdown({}, ctx);
    shutdown({}, ctx);

    expect(setHeader).toHaveBeenCalledTimes(2);
    expect(welcomeLines("Hello.", "/work/pipkin", 80, theme)).toEqual([
      "Hello.",
      "pipkin",
    ]);
  });
});
