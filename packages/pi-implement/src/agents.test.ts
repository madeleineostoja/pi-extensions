import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getGlobalReviewAgentPath,
  globalReviewAgentExists,
  scaffoldGlobalReviewAgent,
} from "./agents.js";

describe("review agent scaffolding", () => {
  it("writes the bundled review agent globally", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-implement-agents-"));
    const result = scaffoldGlobalReviewAgent(agentDir);

    expect(result).toEqual({
      ok: true,
      path: getGlobalReviewAgentPath(agentDir),
    });
    expect(globalReviewAgentExists(agentDir)).toBe(true);
    const content = await readFile(getGlobalReviewAgentPath(agentDir), "utf-8");
    expect(content).toContain("display_name: Review");
    expect(content).toContain("prompt_mode: append");
  });

  it("fails when review already exists", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-implement-agents-"));
    scaffoldGlobalReviewAgent(agentDir);

    const result = scaffoldGlobalReviewAgent(agentDir);

    expect(result).toMatchObject({ ok: false });
    expect(result.path).toBe(getGlobalReviewAgentPath(agentDir));
  });
});
