import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PapercutProposalSchema,
  registerProposalTool,
} from "./proposal-tool.js";
import { createPapercutStatusController } from "./status.js";
import { createPapercutStore } from "./store.js";

const roots: string[] = [];

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-papercuts-proposal-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function proposalTool() {
  let tool: any;
  registerProposalTool(
    {
      registerTool: (definition: unknown) => {
        tool = definition;
      },
    } as never,
    createPapercutStatusController(),
  );
  return tool;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const proposal = {
  key: "devcontainer-validation",
  title: "Validation needs the devcontainer",
  trigger: "Ruby validation runs on the host",
  impact: "Future sessions waste time",
  currentGap: "No preflight instruction exists",
  proposedResolution: "Add a preflight",
  suggestedDestination: "agents" as const,
};

describe("proposal tool", () => {
  it("registers required concrete fields without guidelines", () => {
    const tool = proposalTool();

    expect(tool.name).toBe("propose_papercut");
    expect(tool.promptSnippet).toContain("propose_papercut");
    expect(tool).not.toHaveProperty("promptGuidelines");
    expect(tool.description).toContain("expected intermediate");
    expect(tool.description).toContain("ordinary self-corrected");
    expect(tool.description).toContain("correctly anticipated and handled");
    expect(tool.parameters.required).toEqual(
      expect.arrayContaining(["currentGap", "proposedResolution"]),
    );
    expect(PapercutProposalSchema.required).toEqual(
      expect.arrayContaining(["currentGap", "proposedResolution"]),
    );
  });

  it("rejects malformed runtime proposals without persisting them", async () => {
    const tool = proposalTool();
    const ctx = {
      cwd: repo(),
      mode: "json",
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };

    const result = await tool.execute(
      "id",
      { ...proposal, impact: 42 },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("Papercut rejected");
    expect(result.details.kind).toBe("rejected");
  });

  it("reports every durable proposal outcome without editing project source", async () => {
    const tool = proposalTool();
    const root = repo();
    const ctx = {
      cwd: root,
      mode: "json",
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };

    await expect(
      tool.execute("created", proposal, undefined, undefined, ctx),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringContaining("Papercut created"),
        }),
      ],
      details: { kind: "created" },
    });
    await expect(
      tool.execute("merged", proposal, undefined, undefined, ctx),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringContaining("Papercut merged into pending"),
        }),
      ],
      details: { kind: "merged" },
    });
    const store = createPapercutStore(root);
    await store.transition(proposal.key, "ignored", { note: "not now" });
    await expect(
      tool.execute("ignored", proposal, undefined, undefined, ctx),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringContaining("Papercut already ignored"),
        }),
      ],
      details: { kind: "ignored" },
    });
    await store.transition(proposal.key, "resolved", { target: "AGENTS.md" });
    await expect(
      tool.execute("resolved", proposal, undefined, undefined, ctx),
    ).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringContaining("Papercut already resolved"),
        }),
      ],
      details: { kind: "resolved" },
    });
  });
});
