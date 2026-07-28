import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import registerContext from "./index.ts";
import { EPOCH_TYPE } from "./policy.ts";

function readCall(id: string) {
  return {
    role: "assistant" as const,
    content: [
      {
        type: "toolCall" as const,
        id,
        name: "read",
        arguments: { path: "a.ts", offset: 1, limit: 200 },
      },
    ],
  };
}

function readResult(id: string, lines: number, text = "x".repeat(40_000)) {
  return {
    role: "toolResult" as const,
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: 1,
    details: {
      truncation: {
        content: text,
        totalLines: lines,
        totalBytes: 40_000,
        outputLines: lines,
        outputBytes: 40_000,
        truncated: false,
        truncatedBy: null,
        lastLinePartial: false,
        firstLineExceedsLimit: false,
        maxLines: 2_000,
        maxBytes: 50_000,
      },
    },
  };
}

function createContextRuntime(manager = SessionManager.inMemory("/work")) {
  let contextHandler: any;
  let sessionStartHandler: any;
  const notifications: string[] = [];
  registerContext({
    on: (event: string, handler: unknown) => {
      if (event === "context") {
        contextHandler = handler;
      }
      if (event === "session_start") {
        sessionStartHandler = handler;
      }
    },
    registerTool: () => {},
    registerEntryRenderer: () => {},
    appendEntry: (customType: string, data: unknown) =>
      manager.appendCustomEntry(customType, data),
  } as never);
  const ctx = {
    cwd: "/work",
    model: undefined,
    sessionManager: manager,
    ui: { notify: (message: string) => notifications.push(message) },
  };
  sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);
  return {
    context: (messages: any[]) =>
      contextHandler({ type: "context", messages }, ctx),
    notifications,
  };
}

function staleMessages() {
  return [
    readResult("source", 100, "x".repeat(4_000)),
    { role: "user" as const, content: "one", timestamp: 2 },
    { role: "user" as const, content: "two", timestamp: 3 },
    { role: "user" as const, content: "three", timestamp: 4 },
    { role: "user" as const, content: "four", timestamp: 5 },
  ];
}

describe("Context registration", () => {
  it("installs the Context epoch renderer without session side effects", () => {
    let customType: string | undefined;
    let renderer: unknown;
    registerContext({
      on: () => {},
      registerTool: () => {},
      registerEntryRenderer: (type: string, registered: unknown) => {
        customType = type;
        renderer = registered;
      },
    } as never);

    expect(customType).toBe(EPOCH_TYPE);
    expect(renderer).toBeTypeOf("function");
  });

  it("does not alter sibling read results before their first provider exposure", () => {
    let contextHandler: any;
    const entries: any[] = [
      { type: "model_change", provider: "other", modelId: "other" },
      { type: "model_change", provider: "test", modelId: "model" },
    ];
    registerContext({
      on: (event: string, handler: unknown) => {
        if (event === "context") {
          contextHandler = handler;
        }
      },
      registerTool: () => {},
      registerEntryRenderer: () => {},
      appendEntry: (customType: string, data: unknown) =>
        entries.push({ type: "custom", id: "epoch", customType, data }),
    } as never);
    const messages = [
      {
        role: "assistant" as const,
        content: [readCall("early").content[0], readCall("late").content[0]],
      },
      readResult("early", 2),
      readResult("late", 100),
    ];
    const ctx = {
      cwd: "/work",
      model: { provider: "test", id: "model" },
      sessionManager: {
        getBranch: () => entries,
        getLeafId: () => null,
      },
      ui: { notify: () => {} },
    };

    const first = contextHandler({ type: "context", messages }, ctx);

    expect(first.messages).toEqual(messages);
    expect(entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ customType: EPOCH_TYPE }),
      ]),
    );

    messages.push({ role: "assistant", content: [] });
    const exposed = contextHandler({ type: "context", messages }, ctx);

    expect((exposed.messages[1] as any).content[0]?.text).toContain(
      'context_recall("early")',
    );
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          customType: EPOCH_TYPE,
          data: expect.objectContaining({ kind: "known-cold" }),
        }),
      ]),
    );
    expect((messages[1] as any)?.content[0]?.text).toHaveLength(40_000);
  });

  it("restores byte-identical epoch stubs after feature re-instantiation", () => {
    const manager = SessionManager.inMemory("/work");
    const messages = staleMessages();
    for (const message of messages) {
      manager.appendMessage(message as never);
    }

    const first = createContextRuntime(manager).context(messages);
    const restored = createContextRuntime(manager).context(messages);

    expect((first.messages[0] as any).content[0].text).toContain(
      'context_recall("source")',
    );
    expect(first.messages[0]?.content).toEqual(restored.messages[0]?.content);
    expect(
      manager
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === EPOCH_TYPE,
        ),
    ).toHaveLength(1);
    expect((messages[0] as any).content[0].text).toHaveLength(4_000);
  });

  it("rolls back failed epoch persistence across repeated context passes", () => {
    const manager = SessionManager.inMemory("/work") as any;
    const messages = staleMessages();
    for (const message of messages) {
      manager.appendMessage(message);
    }
    manager._persist = () => {
      throw new Error("disk unavailable");
    };
    const runtime = createContextRuntime(manager);

    const first = runtime.context(messages);
    const repeated = runtime.context(messages);

    expect(first.messages[0]).toEqual(messages[0]);
    expect(repeated.messages[0]).toEqual(messages[0]);
    expect(manager.getBranch()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ customType: EPOCH_TYPE }),
      ]),
    );
    expect(runtime.notifications).toEqual([
      "Context: could not persist pruning epoch",
    ]);
  });
});
