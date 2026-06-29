import { describe, expect, it } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import registerExtension from "./index.js";

function makeFakePi() {
  const handlers = new Map<
    string,
    ((event: unknown, ctx: ExtensionContext) => unknown)[]
  >();
  const pi = {
    on: (
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
    },
    getThinkingLevel: () => "off" as never,
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function makeFakeCtx(
  overrides: {
    mode?: "tui" | "rpc" | "json" | "print";
    branch?: unknown[];
    model?: { name?: string; id?: string; provider?: string } | undefined;
    modelRegistry?: unknown;
    getContextUsage?: () => unknown;
  } = {},
) {
  const footerCallbacks: Array<
    (tui: unknown, theme: unknown, footerData: unknown) => unknown
  > = [];

  const ctx = {
    mode: overrides.mode ?? "tui",
    cwd: "/test",
    model: overrides.model,
    modelRegistry: overrides.modelRegistry ?? {
      find: () => undefined,
      isUsingOAuth: () => false,
    },
    sessionManager: {
      getBranch: () => overrides.branch ?? [],
    },
    getContextUsage: overrides.getContextUsage ?? (() => undefined),
    ui: {
      setFooter: (
        callback: (
          tui: unknown,
          theme: unknown,
          footerData: unknown,
        ) => unknown,
      ) => {
        footerCallbacks.push(callback);
      },
      theme: {
        fg: (_color: string, text: string) => text,
        bg: () => "",
        bold: (t: string) => t,
        italic: (t: string) => t,
        underline: (t: string) => t,
        inverse: (t: string) => t,
        strikethrough: (t: string) => t,
        getFgAnsi: () => "",
        getBgAnsi: () => "",
        getColorMode: () => "truecolor" as const,
        getThinkingBorderColor: () => (s: string) => s,
        getBashModeBorderColor: () => (s: string) => s,
      },
    },
  } as unknown as ExtensionContext;

  return { ctx, footerCallbacks };
}

function makeFakeTui() {
  const renderRequests: number[] = [];
  return {
    requestRender: () => {
      renderRequests.push(Date.now());
    },
    getRenderRequests: () => renderRequests,
  };
}

function makeFakeFooterData() {
  return {
    onBranchChange: () => () => {},
    getGitBranch: () => "main",
    getExtensionStatuses: () => new Map(),
  };
}

describe("footer extension", () => {
  it("preserves subscription hiding behaviour", async () => {
    const { pi, handlers } = makeFakePi();
    registerExtension(pi);

    const { ctx, footerCallbacks } = makeFakeCtx({
      branch: [
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-test",
            usage: {
              input: 1000,
              output: 1000,
              cost: { input: 0.01, output: 0.02, total: 0.03 },
            },
          },
        },
      ],
      modelRegistry: {
        find: () => ({ provider: "anthropic", id: "claude-test" }),
        isUsingOAuth: (model: { provider?: string }) =>
          model.provider === "anthropic",
      },
      model: { provider: "anthropic", id: "claude-test" },
    });
    const handler = handlers.get("session_start")![0];
    await handler({} as SessionStartEvent, ctx);

    const tui = makeFakeTui();
    const footerData = makeFakeFooterData();
    const footer = footerCallbacks[0](tui, ctx.ui.theme, footerData) as {
      render: (width: number) => string[];
    };
    const lines = footer.render(120);

    expect(lines[0]).not.toContain("$");
  });
});
