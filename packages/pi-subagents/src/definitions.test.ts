import { describe, expect, it } from "vitest";
import {
  AgentDefinitionRegistry,
  createAgentDefinitionRegistry,
  PUBLIC_BUILTIN_DEFINITIONS,
} from "./definitions.js";

describe("AgentDefinitionRegistry", () => {
  it("registers equivalent definitions idempotently", () => {
    const registry = new AgentDefinitionRegistry();
    const definition = {
      type: "Internal",
      title: "Internal",
      description: "Internal test subagent",
      visibility: "internal" as const,
    };

    expect(registry.register(definition)).toEqual(definition);
    expect(registry.register({ ...definition })).toEqual(definition);
    expect(registry.list()).toEqual([definition]);
  });

  it("rejects conflicting definitions", () => {
    const registry = new AgentDefinitionRegistry();
    registry.register({
      type: "General",
      title: "General",
      description: "Original",
      visibility: "public",
    });

    expect(() =>
      registry.register({
        type: "General",
        title: "General",
        description: "Changed",
        visibility: "public",
      }),
    ).toThrow(/Conflicting subagent definition/);
  });

  it("lists public definitions separately from internal definitions", () => {
    const registry = createAgentDefinitionRegistry();
    const internal = {
      type: "Implement",
      title: "Implement",
      description: "Internal implementer",
      visibility: "internal" as const,
    };
    registry.register(internal);

    expect(registry.listPublic()).toEqual(PUBLIC_BUILTIN_DEFINITIONS);
    expect(registry.listInternal()).toEqual([internal]);
  });
});
