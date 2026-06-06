import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import registerExtension from "./index.js";

const refreshCurrencyRateMock = vi.hoisted(() => vi.fn());
const convertCurrencyMock = vi.hoisted(() => vi.fn());

vi.mock("@pi-extensions/lib", () => {
  return {
    refreshCurrencyRate: refreshCurrencyRateMock,
    convertCurrency: convertCurrencyMock,
  };
});

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
    hasUI?: boolean;
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
    hasUI: overrides.hasUI ?? true,
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
  beforeEach(() => {
    refreshCurrencyRateMock.mockReset();
    convertCurrencyMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls refreshCurrencyRate during setup and requests render when it resolves", async () => {
    let resolveRefresh: () => void = () => {};
    refreshCurrencyRateMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const { pi, handlers } = makeFakePi();
    registerExtension(pi);

    const { ctx, footerCallbacks } = makeFakeCtx();
    const handler = handlers.get("session_start")![0];
    await handler({} as SessionStartEvent, ctx);

    expect(footerCallbacks).toHaveLength(1);
    const tui = makeFakeTui();
    const footerData = makeFakeFooterData();
    footerCallbacks[0](tui, ctx.ui.theme, footerData);

    expect(refreshCurrencyRateMock).toHaveBeenCalledWith({
      from: "USD",
      to: "NZD",
    });
    expect(tui.getRenderRequests()).toHaveLength(0);

    resolveRefresh();
    await new Promise((r) => setTimeout(r, 0));

    expect(tui.getRenderRequests()).toHaveLength(1);
  });

  it("hides cost when convertCurrency returns undefined", async () => {
    refreshCurrencyRateMock.mockResolvedValue(undefined);
    convertCurrencyMock.mockReturnValue(undefined);

    const { pi, handlers } = makeFakePi();
    registerExtension(pi);

    const { ctx, footerCallbacks } = makeFakeCtx({
      branch: [
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-test",
            usage: {
              input: 1000,
              output: 1000,
              cost: { input: 0.01, output: 0.02, total: 0.03 },
            },
          },
        },
      ],
    });
    const handler = handlers.get("session_start")![0];
    await handler({} as SessionStartEvent, ctx);

    const tui = makeFakeTui();
    const footerData = makeFakeFooterData();
    const footer = footerCallbacks[0](tui, ctx.ui.theme, footerData) as {
      render: (width: number) => string[];
    };
    const lines = footer.render(120);

    expect(convertCurrencyMock).toHaveBeenCalledWith({
      amount: 0.03,
      from: "USD",
      to: "NZD",
    });
    expect(lines[0]).not.toContain("$");
  });

  it("shows converted cost when convertCurrency returns a value", async () => {
    refreshCurrencyRateMock.mockResolvedValue(undefined);
    convertCurrencyMock.mockReturnValue(0.051);

    const { pi, handlers } = makeFakePi();
    registerExtension(pi);

    const { ctx, footerCallbacks } = makeFakeCtx({
      branch: [
        {
          type: "message",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-test",
            usage: {
              input: 1000,
              output: 1000,
              cost: { input: 0.01, output: 0.02, total: 0.03 },
            },
          },
        },
      ],
    });
    const handler = handlers.get("session_start")![0];
    await handler({} as SessionStartEvent, ctx);

    const tui = makeFakeTui();
    const footerData = makeFakeFooterData();
    const footer = footerCallbacks[0](tui, ctx.ui.theme, footerData) as {
      render: (width: number) => string[];
    };
    const lines = footer.render(120);

    expect(convertCurrencyMock).toHaveBeenCalledWith({
      amount: 0.03,
      from: "USD",
      to: "NZD",
    });
    expect(lines[0]).toContain("$0.05");
  });

  it("preserves subscription hiding behaviour", async () => {
    refreshCurrencyRateMock.mockResolvedValue(undefined);
    convertCurrencyMock.mockReturnValue(0.051);

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
