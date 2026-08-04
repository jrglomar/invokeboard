import { describe, it, expect } from "vitest";
import { groupPrsByAssignee, STATUS_RANK, UNASSIGNED_PERSON } from "./prsByPerson";
import type { IssueSummary, LinkedPr } from "./types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function issue(over: Partial<IssueSummary> & { key: string }): IssueSummary {
  return {
    summary: "Some ticket",
    status: "In Progress",
    statusCategory: "inprogress",
    assignee: null,
    assigneeAccountId: null,
    storyPoints: null,
    issueType: "Task",
    url: `https://jira.example.com/browse/${over.key}`,
    blocked: false,
    ...over,
  };
}

function pr(over: Partial<LinkedPr> & { url: string }): LinkedPr {
  return {
    title: "PR title",
    repo: "o/repo",
    status: "open",
    decision: "review_required",
    approvals: 0,
    reviewers: [],
    ...over,
  };
}

const ISSUES: IssueSummary[] = [
  issue({ key: "DEV-1", assignee: "Alice Smith" }),
  issue({ key: "DEV-2", assignee: "Bob" }),
  issue({ key: "DEV-3", assignee: null }),
];

// ── groupPrsByAssignee ────────────────────────────────────────────────────────

describe("groupPrsByAssignee", () => {
  it("empty input returns an empty array", () => {
    expect(groupPrsByAssignee([], {})).toEqual([]);
  });

  it("groups several PRs across two assignees", () => {
    const issuePrs: Record<string, LinkedPr[]> = {
      "DEV-1": [pr({ url: "u1", title: "Alice's PR" })],
      "DEV-2": [pr({ url: "u2", title: "Bob's PR" })],
    };
    const groups = groupPrsByAssignee(ISSUES, issuePrs);
    expect(groups.map((g) => g.person)).toEqual(["Alice Smith", "Bob"]);
    expect(groups[0].prs.map((p) => p.pr.url)).toEqual(["u1"]);
    expect(groups[1].prs.map((p) => p.pr.url)).toEqual(["u2"]);
  });

  it("puts PRs on unassigned or unknown issues into the Unassigned bucket, sorted last", () => {
    const issuePrs: Record<string, LinkedPr[]> = {
      "DEV-1": [pr({ url: "u1" })],
      "DEV-3": [pr({ url: "u3" })], // DEV-3 has assignee: null
    };
    const groups = groupPrsByAssignee(ISSUES, issuePrs);
    expect(groups.map((g) => g.person)).toEqual(["Alice Smith", UNASSIGNED_PERSON]);
    const unassigned = groups[groups.length - 1];
    expect(unassigned.person).toBe("Unassigned");
    expect(unassigned.prs.map((p) => p.pr.url)).toEqual(["u3"]);
  });

  it("routes an issue key present in issuePrs but absent from issues to Unassigned", () => {
    const issuePrs: Record<string, LinkedPr[]> = {
      "DEV-404": [pr({ url: "u404" })],
    };
    const groups = groupPrsByAssignee(ISSUES, issuePrs);
    expect(groups).toHaveLength(1);
    expect(groups[0].person).toBe(UNASSIGNED_PERSON);
    expect(groups[0].prs[0].issueKey).toBe("DEV-404");
  });

  it("de-dupes the same PR URL linked to two tickets for the same person (first sorted key wins)", () => {
    const issuePrs: Record<string, LinkedPr[]> = {
      "DEV-9": [pr({ url: "shared-url", title: "Shared" })],
      "DEV-1": [pr({ url: "shared-url", title: "Shared" })],
    };
    // Both DEV-1 and DEV-9 are Alice's — add DEV-9 as Alice's too so both land in one bucket.
    const issuesWithDev9 = [...ISSUES, issue({ key: "DEV-9", assignee: "Alice Smith" })];
    const groups = groupPrsByAssignee(issuesWithDev9, issuePrs);
    const alice = groups.find((g) => g.person === "Alice Smith")!;
    expect(alice.prs).toHaveLength(1);
    // Keys are walked sorted ("DEV-1" < "DEV-9"), so DEV-1 wins attribution.
    expect(alice.prs[0].issueKey).toBe("DEV-1");
  });

  it("the same PR URL linked to two DIFFERENT people's tickets appears once per person", () => {
    const issuePrs: Record<string, LinkedPr[]> = {
      "DEV-1": [pr({ url: "cross-url" })], // Alice
      "DEV-2": [pr({ url: "cross-url" })], // Bob
    };
    const groups = groupPrsByAssignee(ISSUES, issuePrs);
    const alice = groups.find((g) => g.person === "Alice Smith")!;
    const bob = groups.find((g) => g.person === "Bob")!;
    expect(alice.prs.map((p) => p.pr.url)).toEqual(["cross-url"]);
    expect(bob.prs.map((p) => p.pr.url)).toEqual(["cross-url"]);
  });

  it("orders a person's PRs open-before-merged via STATUS_RANK", () => {
    const issuePrs: Record<string, LinkedPr[]> = {
      "DEV-1": [
        pr({ url: "merged-one", title: "Merged one", status: "merged" }),
        pr({ url: "open-one", title: "Open one", status: "open" }),
      ],
    };
    const groups = groupPrsByAssignee(ISSUES, issuePrs);
    const alice = groups.find((g) => g.person === "Alice Smith")!;
    expect(alice.prs.map((p) => p.pr.url)).toEqual(["open-one", "merged-one"]);
  });

  it("derives initials per group", () => {
    const issuePrs: Record<string, LinkedPr[]> = {
      "DEV-1": [pr({ url: "u1" })],
      "DEV-3": [pr({ url: "u3" })],
    };
    const groups = groupPrsByAssignee(ISSUES, issuePrs);
    const alice = groups.find((g) => g.person === "Alice Smith")!;
    expect(alice.initials).toBe("AS");
    const unassigned = groups.find((g) => g.person === UNASSIGNED_PERSON)!;
    expect(unassigned.initials).toBe("?");
  });

  it("ignores issue keys with an empty PR array", () => {
    const groups = groupPrsByAssignee(ISSUES, { "DEV-1": [] });
    expect(groups).toEqual([]);
  });
});

// ── STATUS_RANK ───────────────────────────────────────────────────────────────

describe("STATUS_RANK", () => {
  it("ranks open before unknown before merged before declined", () => {
    expect(STATUS_RANK.open).toBeLessThan(STATUS_RANK.unknown);
    expect(STATUS_RANK.unknown).toBeLessThan(STATUS_RANK.merged);
    expect(STATUS_RANK.merged).toBeLessThan(STATUS_RANK.declined);
  });
});
