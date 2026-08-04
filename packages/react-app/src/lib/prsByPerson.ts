/**
 * Code-review PR "By person" grouping (v1.73, ADR-084).
 * Pure client-side regroup of the SAME get_issue_pull_requests data the PullRequestsCard already
 * has — attributes each linked PR to the Jira ASSIGNEE of the ticket it is linked to (never the
 * GitHub PR author: mcp-github's :4002 bridge has no tenant context, so filtering by GitHub login
 * there would leak across tenants — see ADR-084 / the Wave 2b spec). No network calls.
 */

import type { IssueSummary, LinkedPr } from "./types";
import { deriveInitials } from "./huddleRegroup";

// ── Shared PR ordering ───────────────────────────────────────────────────────

/**
 * Sort still-open PRs first, then merged, then declined — actionable ones on top.
 * SINGLE SOURCE OF TRUTH: PullRequestsCard imports this rather than keeping its own copy.
 */
export const STATUS_RANK: Record<LinkedPr["status"], number> = {
  open: 0,
  unknown: 1,
  merged: 2,
  declined: 3,
};

// ── Types ─────────────────────────────────────────────────────────────────────

/** Display bucket for PRs whose issue has no assignee (or no matching issue at all). */
export const UNASSIGNED_PERSON = "Unassigned";

export interface PrPersonGroup {
  /** Assignee display name, or UNASSIGNED_PERSON. */
  person: string;
  /** The assignee's initials (derived via huddleRegroup's deriveInitials). */
  initials: string;
  /** This person's linked PRs, open-first (STATUS_RANK), each paired with the issue key that
   *  attributed it to this person (first-encountered-in-sorted-key-order wins on dedupe). */
  prs: { pr: LinkedPr; issueKey: string }[];
}

// ── groupPrsByAssignee ────────────────────────────────────────────────────────

/**
 * Group linked PRs (get_issue_pull_requests output) by the Jira assignee of the issue each PR
 * is linked to.
 *
 * - An issue key present in `issuePrs` but absent from `issues` (or present with a null
 *   assignee) falls into the UNASSIGNED_PERSON bucket.
 * - Named assignees sort alphabetically; UNASSIGNED_PERSON always sorts last.
 * - The same PR URL can be linked to several tickets. Within a single person's list a given PR
 *   URL appears once — issue keys are walked in sorted order, so the FIRST (alphabetically
 *   lowest) issueKey linking that URL for that person wins and is the one recorded.
 * - Within each person, PRs are ordered open-first via STATUS_RANK (mirrors PullRequestsCard's
 *   auto-PR list ordering).
 */
export function groupPrsByAssignee(
  issues: IssueSummary[],
  issuePrs: Record<string, LinkedPr[]>
): PrPersonGroup[] {
  const assigneeByKey = new Map<string, string | null>();
  for (const issue of issues) {
    assigneeByKey.set(issue.key, issue.assignee);
  }

  const groups = new Map<string, PrPersonGroup>();
  const seenUrlsByPerson = new Map<string, Set<string>>();

  function getOrCreate(person: string): PrPersonGroup {
    let group = groups.get(person);
    if (!group) {
      group = {
        person,
        initials: deriveInitials(person === UNASSIGNED_PERSON ? null : person),
        prs: [],
      };
      groups.set(person, group);
      seenUrlsByPerson.set(person, new Set());
    }
    return group;
  }

  // Sorted issue-key order → deterministic "first encountered wins" de-dup per person.
  for (const issueKey of Object.keys(issuePrs).sort()) {
    const prs = issuePrs[issueKey];
    if (!prs || prs.length === 0) continue;

    const assignee = assigneeByKey.get(issueKey) ?? null; // missing issue → null → Unassigned
    const person = assignee ?? UNASSIGNED_PERSON;
    const group = getOrCreate(person);
    const seenUrls = seenUrlsByPerson.get(person)!;

    for (const pr of prs) {
      if (seenUrls.has(pr.url)) continue;
      seenUrls.add(pr.url);
      group.prs.push({ pr, issueKey });
    }
  }

  for (const group of groups.values()) {
    group.prs.sort((a, b) => STATUS_RANK[a.pr.status] - STATUS_RANK[b.pr.status]);
  }

  return [...groups.values()].sort((a, b) => {
    if (a.person === UNASSIGNED_PERSON && b.person === UNASSIGNED_PERSON) return 0;
    if (a.person === UNASSIGNED_PERSON) return 1;
    if (b.person === UNASSIGNED_PERSON) return -1;
    return a.person.localeCompare(b.person);
  });
}
