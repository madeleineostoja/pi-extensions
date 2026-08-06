import { describe, expect, it } from "vitest";
import {
  CROSS_TOOL_RULES,
  EXTERNAL_EVIDENCE_TOOLS,
  PUBLIC_TOOL_CATALOGUE,
  PUBLIC_TOOL_EXCEPTIONS,
  renderGuidance,
} from "./catalogue.ts";

const catalogueNames = PUBLIC_TOOL_CATALOGUE.map((entry) => entry.name);

describe("Guidance catalogue", () => {
  it("covers the complete public Pipkin surface with explicit named exceptions", () => {
    expect(catalogueNames).toEqual([
      "bash_outcome",
      "context_recall",
      "lsp",
      "start_process",
      "get_process_result",
      "stop_process",
      "Agent",
      "get_subagent_result",
      "steer_subagent",
      "inspect_implement_run",
      "docs",
      "package_search",
      "code_search",
      "web_fetch",
      "batch_web_fetch",
      "record_papercut",
    ]);
    expect(PUBLIC_TOOL_EXCEPTIONS.bash).toContain("native Bash");
    expect(PUBLIC_TOOL_EXCEPTIONS.explore).toContain("private");
    expect(PUBLIC_TOOL_EXCEPTIONS.pi_managed_complete).toContain("private");
    expect(catalogueNames).not.toContain("bash");
  });

  it("renders only active summaries and rules whose every named tool is selected", () => {
    const prompt = renderGuidance(["bash_outcome", "context_recall"])!;

    expect(prompt).toContain("bash_outcome:");
    expect(prompt).toContain("context_recall:");
    expect(prompt).toContain("Recall retained successful outcome output");
    expect(prompt).not.toContain("bash:");
    expect(prompt).not.toContain("start_process");

    for (const rule of CROSS_TOOL_RULES) {
      const allSelected = rule.requiredTools.every((name) =>
        ["bash_outcome", "context_recall"].includes(name),
      );
      expect(prompt.includes(rule.text)).toBe(allSelected);
    }
  });

  it("renders each relationship only when every required tool is active", () => {
    for (const rule of CROSS_TOOL_RULES) {
      const prompt = renderGuidance(rule.requiredTools)!;
      expect(prompt).toContain(rule.text);
      for (const omitted of rule.requiredTools) {
        expect(
          renderGuidance(
            rule.requiredTools.filter((name) => name !== omitted),
          ) ?? "",
        ).not.toContain(rule.text);
      }
    }
  });

  it("preserves managed process and review routing strategy", () => {
    const managed = renderGuidance(["get_process_result", "context_recall"])!;
    expect(managed).toContain("Choose output");
    expect(managed).toContain("point-in-time outcome");
    expect(managed).toContain("later output result");

    const routing = renderGuidance(["Agent", "lsp"])!;
    expect(routing).toContain("Use Review directly");
    expect(routing).toContain("independent Review pass");
    expect(routing).toContain("targeted semantic lookup");
    expect(routing).toContain("multi-step discovery");
    expect(routing).not.toContain("General");
  });

  it("guides asynchronous agent starts and one intentional join", () => {
    const prompt = renderGuidance(["Agent", "get_subagent_result"])!;

    expect(prompt).toContain("Start independent Explore or Review work");
    expect(prompt).toContain("Continue useful independent work");
    expect(prompt).toContain("immediate wait:true join");
    expect(prompt).toContain("do not poll");
    expect(prompt).not.toContain("foreground");
    expect(prompt).not.toContain("background");
  });

  it("states the complete Papercut qualification boundary", () => {
    const prompt = renderGuidance(["record_papercut"])!;
    expect(prompt).toContain("avoidable incidental friction");
    expect(prompt).toContain("another assigned task");
    expect(prompt).toContain("exercised workaround");
    expect(prompt).toContain("completion or safe continuation");
  });

  it("adds external authority guidance only for active evidence tools", () => {
    expect(renderGuidance(["lsp"])!).not.toContain("External content");
    for (const name of EXTERNAL_EVIDENCE_TOOLS) {
      expect(renderGuidance([name])!).toContain("External content");
    }
  });

  it("stays bounded for the complete selected surface", () => {
    const prompt = renderGuidance([...catalogueNames, "bash"]);
    expect(prompt).toBeDefined();
    expect(prompt!.length).toBeLessThan(6_000);
  });
});
