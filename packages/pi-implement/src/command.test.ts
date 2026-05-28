import { describe, expect, it } from "vitest";
import { registerImplementCommand } from "./command.js";

type Handler = (args: string, ctx: FakeContext) => Promise<void>;

type FakeContext = {
  cwd: string;
  hasUI: boolean;
  ui: {
    notifications: Array<{ message: string; level: string }>;
    statuses: Array<{ key: string; text: string | undefined }>;
    notify(message: string, level: string): void;
    setStatus(key: string, text: string | undefined): void;
  };
  model: { provider: string; id: string };
  modelRegistry: { find(provider: string, id: string): unknown };
};

function setup() {
  let handler: Handler | undefined;
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    on: () => {},
    registerCommand: (name: string, options: { handler: Handler }) => {
      if (name === "implement") {
        handler = options.handler;
      }
    },
  };
  registerImplementCommand(pi as never);
  if (!handler) {
    throw new Error("handler not registered");
  }
  const ctx: FakeContext = {
    cwd: "/repo",
    hasUI: true,
    model: { provider: "p", id: "m" },
    modelRegistry: { find: () => ({}) },
    ui: {
      notifications: [],
      statuses: [],
      notify(message: string, level: string) {
        this.notifications.push({ message, level });
      },
      setStatus(key: string, text: string | undefined) {
        this.statuses.push({ key, text });
      },
    },
  };
  return { handler, ctx };
}

describe("/implement command", () => {
  it("shows usage and status with no args", async () => {
    const { handler, ctx } = setup();
    await handler("", ctx);
    expect(ctx.ui.notifications[0]?.message).toContain("Usage: /implement");
    expect(ctx.ui.notifications[0]?.message).toContain("pi-implement: idle");
  });

  it("reports idle status", async () => {
    const { handler, ctx } = setup();
    await handler("status", ctx);
    expect(ctx.ui.notifications[0]).toEqual({
      message: "pi-implement: idle",
      level: "info",
    });
  });
});
