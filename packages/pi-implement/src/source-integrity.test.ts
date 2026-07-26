import { describe, expect, it } from "vitest";
import { resolveCorpusPath, sha256 } from "./source-integrity.js";

describe("source integrity", () => {
  it("resolves only references in the immutable corpus", () => {
    const planPath = "/checkout/plans/plan.md";
    const corpus = [
      { path: planPath, hash: sha256("plan") },
      { path: "/checkout/docs/design.md", hash: sha256("design") },
    ];

    expect(
      resolveCorpusPath({
        planPath,
        checkoutRoot: "/checkout",
        corpus,
        reference: "../docs/design.md",
      }),
    ).toBe("/checkout/docs/design.md");
    expect(() =>
      resolveCorpusPath({
        planPath,
        checkoutRoot: "/checkout",
        corpus,
        reference: "outside.md",
      }),
    ).toThrow("outside the immutable corpus");
  });
});
