// Shared issue-list helpers — CONTRACTS.md §4.31/§4.32/§6 (v1.72, ADR-083)

import type { GetActiveSprintOutput, IssueSummary } from "./types";

/**
 * Flatten a get_active_sprint response's bucketed issuesByStatus into one flat list
 * (todo → inprogress → codereview → done). `null`/`undefined` (no sprint selected /
 * still loading) → `[]`.
 *
 * Moved here in v1.72 (ADR-083) — this exact `[...todo, ...inprogress, ...codereview,
 * ...done]` shape was duplicated ad hoc in at least 4 places (Linking.tsx, Dashboard.tsx
 * ×2, and others) before this became a shared primitive.
 */
export function flattenIssues(
  data: GetActiveSprintOutput | null | undefined
): IssueSummary[] {
  if (!data) return [];
  const b = data.issuesByStatus;
  return [...b.todo, ...b.inprogress, ...b.codereview, ...b.done];
}
