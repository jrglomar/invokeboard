// linkClient.ts — CONTRACTS.md §4.17 v1.11, ADR-022
// Wraps get_linked_issues via the HTTP bridge. Same McpError semantics as mcpClient.

import { callTool } from "./mcpClient";
import type {
  GetLinkedIssuesResponse,
  GetIssueDescriptionsResponse,
  LinkDevToPoResult,
  UnlinkDevFromPoResult,
} from "./types";

/**
 * For each PO key, fetch its existing linked Dev tickets (default projectKey = Dev).
 * Pass projectKey="" to return links to any project. Returns `{ links: { poKey: LinkedIssue[] } }`
 * with an entry for every input key ([] when none).
 */
export async function getLinkedIssues(
  keys: string[],
  projectKey?: string
): Promise<GetLinkedIssuesResponse> {
  const input: { keys: string[]; projectKey?: string } = { keys };
  if (projectKey !== undefined) input.projectKey = projectKey;
  return callTool<GetLinkedIssuesResponse>("jira", "get_linked_issues", input);
}

/**
 * For each issue key, fetch its description as plain text (v1.14, ADR-025). Returns
 * `{ descriptions: { key: string } }` with an entry for every input key ("" when none).
 * Used by the Linking page to draft each Dev task from the PO story's real description.
 */
export async function getIssueDescriptions(
  keys: string[]
): Promise<GetIssueDescriptionsResponse> {
  return callTool<GetIssueDescriptionsResponse>("jira", "get_issue_descriptions", { keys });
}

/**
 * Link an EXISTING Dev ticket to an EXISTING PO story (CONTRACTS.md §4.31, v1.72,
 * ADR-083). One pair per call — bulk "Link N to PO-7" loops this sequentially through
 * the shared bulk-run machine. `linkId` on the result is non-null ONLY when
 * `alreadyLinked` is true.
 */
export async function linkDevToPo(
  poKey: string,
  devKey: string
): Promise<LinkDevToPoResult> {
  return callTool<LinkDevToPoResult>("jira", "link_dev_to_po", { poKey, devKey });
}

/**
 * Remove a PO↔Dev link (CONTRACTS.md §4.32, v1.72, ADR-083). `poKey`/`devKey` are an
 * optional guard — the Linking UI always sends them so a stale badge can never delete
 * an unrelated link.
 */
export async function unlinkDevFromPo(input: {
  linkId: string;
  poKey?: string;
  devKey?: string;
}): Promise<UnlinkDevFromPoResult> {
  return callTool<UnlinkDevFromPoResult>("jira", "unlink_dev_from_po", input);
}
