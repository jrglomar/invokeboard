// poRollup tests — the deterministic PO-story rollup builder used as the client-side
// fallback for POST /api/ai/draft-po-story (CONTRACTS.md §4.9 v1.72, ADR-083).
// Pure module: no rendering, no mocks needed.

import { describe, it, expect } from "vitest";
import { buildPoRollupDraft, capDesc, DESC_CAP, type PoRollupDevTicket } from "./poRollup";

describe("buildPoRollupDraft", () => {
  it("a single Dev ticket keeps its summary verbatim", () => {
    const tickets: PoRollupDevTicket[] = [{ key: "DEV-1", summary: "Add reset endpoint" }];
    const draft = buildPoRollupDraft(tickets);

    expect(draft.summary).toBe("Add reset endpoint");
    expect(draft.description).toContain("- DEV-1 — Add reset endpoint");
  });

  it("N tickets roll up to '<first summary> (+N-1 more)'", () => {
    const tickets: PoRollupDevTicket[] = [
      { key: "DEV-1", summary: "Add reset endpoint" },
      { key: "DEV-2", summary: "Add reset email" },
      { key: "DEV-3", summary: "Add reset UI" },
    ];
    const draft = buildPoRollupDraft(tickets);

    expect(draft.summary).toBe("Add reset endpoint (+2 more)");
  });

  it("truncates a too-long summary to <=255 chars with a trailing ellipsis", () => {
    const longSummary = "A".repeat(300);
    const draft = buildPoRollupDraft([{ key: "DEV-1", summary: longSummary }]);

    expect(draft.summary.length).toBeLessThanOrEqual(255);
    expect(draft.summary.endsWith("…")).toBe(true);
  });

  it("description's '## Delivered by' section has one '- KEY — summary' bullet per ticket", () => {
    const tickets: PoRollupDevTicket[] = [
      { key: "DEV-1", summary: "Add reset endpoint" },
      { key: "DEV-2", summary: "Add reset email" },
    ];
    const draft = buildPoRollupDraft(tickets);

    expect(draft.description).toContain("## Delivered by");
    expect(draft.description).toContain("- DEV-1 — Add reset endpoint");
    expect(draft.description).toContain("- DEV-2 — Add reset email");
  });

  it("omits '## Source Dev tasks' entirely when no ticket has a description", () => {
    const noDesc = buildPoRollupDraft([
      { key: "DEV-1", summary: "Add reset endpoint" },
      { key: "DEV-2", summary: "Add reset email", description: "   " }, // whitespace-only = no description
    ]);
    expect(noDesc.description).not.toContain("## Source Dev tasks");

    const withDesc = buildPoRollupDraft([
      { key: "DEV-1", summary: "Add reset endpoint" },
      { key: "DEV-2", summary: "Add reset email", description: "uses SES for delivery" },
    ]);
    expect(withDesc.description).toContain("## Source Dev tasks");
    expect(withDesc.description).toContain("### DEV-2");
    expect(withDesc.description).toContain("uses SES for delivery");
  });
});

describe("capDesc", () => {
  it("truncates text past DESC_CAP and appends a '(truncated)' marker", () => {
    const long = "x".repeat(DESC_CAP + 50);
    const capped = capDesc(long);

    expect(capped.length).toBe(DESC_CAP + "\n… (truncated)".length);
    expect(capped.endsWith("(truncated)")).toBe(true);
  });

  it("leaves text at or under DESC_CAP untouched (aside from trimming)", () => {
    const short = "Reset flow notes";
    expect(capDesc(short)).toBe(short);
  });
});
