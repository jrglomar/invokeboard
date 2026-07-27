// toolCatalog.ts unit tests (v1.56, ADR-067) — shape checks + anti-drift guards.
//
// The anti-drift tests inline hand-synced copies of the allowlists that toolCatalog.ts's
// `aiAssistant` field is deliberately duplicating (react-app can't import mcp-jira's
// server-only modules into the browser bundle — see the header comment in toolCatalog.ts).
// If those source-of-truth lists ever move, these copies (and the ones in toolCatalog.ts)
// need to be updated together.

import { describe, it, expect } from "vitest";
import { TOOL_CATALOG, TOOL_GROUPS, type ToolGroup } from "./toolCatalog";

// hand-synced copy — must match packages/mcp-jira/src/lib/ai/askService.ts (READ_TOOLS)
const ASK_SERVICE_READ_TOOLS: readonly string[] = [
  "get_active_sprint",
  "get_daily_huddle",
  "get_impediments",
  "get_pull_requests",
  "get_post_scrum",
  "get_meeting_goal",
  "get_leaves",
  "get_sprint_report",
  "get_velocity",
  "get_team_members",
  "get_ticket",
  "list_sprints",
  "get_linked_issues",
  "get_issue_pull_requests",
  "get_all_leaves",
  "get_offset_ledger",
  "get_meeting_notes",
  "get_retro",
  "get_multi_sprint_report",
  // v1.68 (ADR-079) — was missing from this copy AND from toolCatalog.ts until v1.72;
  // the two omissions cancelled out, so ANTI-DRIFT A passed while both were wrong.
  "get_draft_plan",
];

// hand-synced copy — must match packages/mcp-jira/src/lib/ai/askService.ts (WRITE_TOOLS)
const ASK_SERVICE_WRITE_TOOLS: readonly string[] = [
  "update_ticket",
  "transition_issue",
  "move_issue_to_sprint",
  "create_sprint",
  "set_sprint_goal",
  "assign_issue",
  "set_leaves",
];

// hand-synced copy — must match packages/mcp-jira/src/lib/delegation.ts (JIRA_WRITE_TOOLS)
const DELEGATION_JIRA_WRITE_TOOLS: readonly string[] = [
  "create_po_ticket",
  "create_dev_ticket",
  "update_ticket",
  "create_sprint",
  "set_sprint_goal",
  "assign_issue",
  "transition_issue",
  "move_issue_to_sprint",
  // v1.72 (ADR-083) — linking existing issues mutates Jira, so both are write-gated
  "link_dev_to_po",
  "unlink_dev_from_po",
];

const EXPECTED_GROUP_COUNTS: Record<ToolGroup, number> = {
  "Ticket CRUD": 5,
  "Sprint reads": 3,
  "Sprint management": 5,
  "Reports & velocity": 3,
  "Assignment & roster": 7,
  "Leaves & offset wallet": 8,
  "Huddle stores": 12,
  "Linking & PR visibility": 4,
  "GitHub pull requests": 5,
};

/** Sorted names — used so array comparisons act like set-equality regardless of order. */
function sortedNames(entries: { name: string }[]): string[] {
  return entries.map((t) => t.name).sort();
}

describe("TOOL_CATALOG", () => {
  it("has exactly 52 rows", () => {
    expect(TOOL_CATALOG.length).toBe(52);
  });

  it("has the expected count per group", () => {
    const actual: Record<string, number> = {};
    for (const t of TOOL_CATALOG) actual[t.group] = (actual[t.group] ?? 0) + 1;
    expect(actual).toEqual(EXPECTED_GROUP_COUNTS);
  });

  it("has unique tool names", () => {
    const names = new Set(TOOL_CATALOG.map((t) => t.name));
    expect(names.size).toBe(52);
  });

  it("splits 47 mcp-jira / 5 mcp-github by server", () => {
    const jira = TOOL_CATALOG.filter((t) => t.server === "mcp-jira");
    const github = TOOL_CATALOG.filter((t) => t.server === "mcp-github");
    // 47 === the mcp-jira registry's tool count (scripts/smoke.mjs EXPECTED_JIRA_TOOLS)
    expect(jira.length).toBe(47);
    expect(github.length).toBe(5);
  });

  it("has the expected surface x access totals", () => {
    const count = (surface: string, access: string) =>
      TOOL_CATALOG.filter((t) => t.surface === surface && t.access === access).length;

    expect(count("jira", "read")).toBe(13);
    expect(count("jira", "write")).toBe(10);
    expect(count("local", "read")).toBe(11);
    expect(count("local", "write")).toBe(13);
    expect(count("github", "read")).toBe(3);
    expect(count("github", "write")).toBe(2);
  });

  it("names are snake_case lowercase words", () => {
    for (const t of TOOL_CATALOG) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it("blurbs are non-empty and reasonably short (<= 110 chars)", () => {
    for (const t of TOOL_CATALOG) {
      expect(t.blurb.length).toBeGreaterThan(0);
      expect(t.blurb.length).toBeLessThanOrEqual(110);
    }
  });

  it("ANTI-DRIFT A: aiAssistant 'read'/'propose' tools match askService.ts's allowlists", () => {
    const catalogRead = sortedNames(TOOL_CATALOG.filter((t) => t.aiAssistant === "read"));
    const catalogPropose = sortedNames(TOOL_CATALOG.filter((t) => t.aiAssistant === "propose"));

    expect(catalogRead).toEqual([...ASK_SERVICE_READ_TOOLS].sort());
    expect(catalogPropose).toEqual([...ASK_SERVICE_WRITE_TOOLS].sort());
  });

  it("ANTI-DRIFT B: jira-surface write tools match delegation.ts's JIRA_WRITE_TOOLS", () => {
    const catalogJiraWrites = sortedNames(
      TOOL_CATALOG.filter((t) => t.surface === "jira" && t.access === "write")
    );
    expect(catalogJiraWrites).toEqual([...DELEGATION_JIRA_WRITE_TOOLS].sort());
  });
});

describe("TOOL_GROUPS", () => {
  it("has exactly 9 groups", () => {
    expect(TOOL_GROUPS.length).toBe(9);
  });

  it("every catalog entry's group is a known TOOL_GROUPS value", () => {
    const known = new Set<string>(TOOL_GROUPS);
    for (const t of TOOL_CATALOG) {
      expect(known.has(t.group)).toBe(true);
    }
  });
});
