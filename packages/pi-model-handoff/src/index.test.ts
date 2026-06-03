import { describe, it, expect } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerExtension from "./index";

describe("pi-model-handoff scaffolding", () => {
  it("exports a default function that accepts an ExtensionAPI", () => {
    const pi = {
      on: () => {},
      registerShortcut: () => {},
      registerCommand: () => {},
      registerTool: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      registerMessageRenderer: () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      getCommands: () => [],
      setModel: () => Promise.resolve(false),
      getThinkingLevel: () => 0 as never,
      setThinkingLevel: () => {},
      exec: () =>
        Promise.resolve({ code: 0, stdout: "", stderr: "", killed: false }),
      registerProvider: () => {},
      unregisterProvider: () => {},
      events: {} as never,
    } as unknown as ExtensionAPI;

    expect(() => registerExtension(pi)).not.toThrow();
  });
});
