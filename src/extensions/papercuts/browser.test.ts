import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPapercutSummary, registerPapercutsBrowser } from "./browser.js";
import { createPapercutStatusController } from "./status.js";
import { createPapercutStore } from "./store.js";

const roots: string[] = [];

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "pipkin-papercuts-browser-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function browserCommand() {
  let command: any;
  registerPapercutsBrowser(
    {
      registerCommand: (_name: string, definition: unknown) => {
        command = definition;
      },
    } as never,
    createPapercutStatusController(),
  );
  return command;
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

describe("papercuts browser", () => {
  it("rejects unexpected command arguments", async () => {
    const command = browserCommand();
    const notify = vi.fn();

    await command.handler("unexpected", {
      cwd: repo(),
      mode: "json",
      hasUI: false,
      ui: { notify },
    });

    expect(notify).toHaveBeenCalledWith("usage: /papercuts", "warning");
  });

  it("runs every menu action durably and leaves Work on this unchanged", async () => {
    const command = browserCommand();
    const root = repo();
    const store = createPapercutStore(root);
    await store.propose(proposal, { kind: "agent" });
    const notify = vi.fn();
    const setEditorText = vi.fn();
    const setStatus = vi.fn();
    const theme = { fg: (_color: string, text: string) => text };
    const runAction = async (
      selections: string[],
      inputs: string[] = [],
      confirmed = true,
    ) => {
      const select = vi.fn(async () => selections.shift());
      const input = vi.fn(async () => inputs.shift());
      await command.handler("", {
        cwd: root,
        mode: "tui",
        hasUI: true,
        ui: {
          select,
          input,
          confirm: vi.fn(async () => confirmed),
          notify,
          setEditorText,
          setStatus,
          theme,
        },
      });
    };
    const pending = () => [
      "Pending (1)",
      `${proposal.key} — ${proposal.title}`,
    ];

    await runAction([...pending(), "Work on this", "Close"]);
    expect(setEditorText).toHaveBeenLastCalledWith(
      expect.stringContaining(
        "Do not change this papercut's status automatically",
      ),
    );
    expect((await store.load()).records[0]).toMatchObject({
      status: "pending",
    });

    await runAction(
      [...pending(), "Mark resolved", "Close"],
      ["fixed", "docs"],
    );
    expect((await store.load()).records[0]).toMatchObject({
      status: "resolved",
      disposition: { note: "fixed", target: "docs" },
    });
    await runAction([
      "Resolved (1)",
      `${proposal.key} — ${proposal.title}`,
      "Reopen",
      "Close",
    ]);
    expect((await store.load()).records[0]).toMatchObject({
      status: "pending",
    });

    await runAction([...pending(), "Ignore", "Close"], ["defer", "backlog"]);
    expect((await store.load()).records[0]).toMatchObject({
      status: "ignored",
      disposition: { note: "defer", target: "backlog" },
    });
    await runAction([
      "Ignored (1)",
      `${proposal.key} — ${proposal.title}`,
      "Reopen",
      "Close",
    ]);

    await runAction(
      [...pending(), "Edit proposal", "Close"],
      [
        proposal.key,
        "Improved title",
        proposal.trigger,
        proposal.impact,
        proposal.currentGap,
        proposal.proposedResolution,
        proposal.suggestedDestination,
      ],
    );
    expect((await store.load()).records[0]).toMatchObject({
      title: "Improved title",
    });
    await runAction([
      "Pending (1)",
      `${proposal.key} — Improved title`,
      "Delete",
      "Close",
    ]);
    expect((await store.load()).records).toEqual([]);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("prints populated deterministic summaries without opening a modal", async () => {
    const command = browserCommand();
    const root = repo();
    await createPapercutStore(root).propose(proposal, { kind: "agent" });
    const notify = vi.fn();

    await command.handler("", {
      cwd: root,
      mode: "json",
      hasUI: false,
      ui: { notify, setStatus: vi.fn() },
    });

    expect(notify).toHaveBeenCalledWith(
      "pending (1)\n- devcontainer-validation: Validation needs the devcontainer (1)\nignored (0)\nresolved (0)",
      "info",
    );
  });

  it("formats deterministic pending-first non-TUI summaries", () => {
    expect(
      formatPapercutSummary({
        version: 1,
        records: [
          {
            ...proposal,
            key: "z",
            status: "resolved",
            occurrences: 1,
            firstSeenAt: "a",
            lastSeenAt: "a",
            sources: [],
          },
          {
            ...proposal,
            key: "a",
            status: "pending",
            occurrences: 2,
            firstSeenAt: "a",
            lastSeenAt: "a",
            sources: [],
          },
        ],
      }),
    ).toBe(
      "pending (1)\n- a: Validation needs the devcontainer (2)\nignored (0)\nresolved (1)\n- z: Validation needs the devcontainer (1)",
    );
  });
});
