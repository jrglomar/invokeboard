/**
 * unlink_dev_from_po tool (v1.72, ADR-083).
 *
 * The counterpart to link_dev_to_po — a mis-link had to be fixed in Jira directly
 * before v1.72. `linkId` is the Jira issue-link id (from get_linked_issues). `poKey`/
 * `devKey` are an optional guard the Linking UI always sends: when both are present,
 * the link is verified to actually connect that pair before it is deleted, so a stale
 * UI can never delete an unrelated link.
 */

import { z } from "zod";
import type { ToolDef } from "../lib/toolDef.js";
import { UpstreamError } from "../lib/errors.js";
import { deleteIssueLink, getLinkedIssues } from "../lib/jiraClient.js";

// Reuses the same ticketKey regex as update_ticket (§4.4).
const TICKET_KEY_REGEX = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

const schema = z.object({
  linkId: z.string().min(1),
  poKey: z
    .string()
    .regex(TICKET_KEY_REGEX, "poKey must match PROJECT-NUMBER format")
    .optional(),
  devKey: z
    .string()
    .regex(TICKET_KEY_REGEX, "devKey must match PROJECT-NUMBER format")
    .optional(),
});

interface UnlinkDevFromPoOutput {
  linkId: string;
  deleted: boolean;
  alreadyGone: boolean;
  poKey?: string;
  devKey?: string;
}

async function handler(input: unknown): Promise<UnlinkDevFromPoOutput> {
  const args = schema.parse(input);

  // Guard — only when both keys are supplied. The Linking UI always sends them; a
  // caller that omits either (e.g. a bare stdio call) skips straight to the delete.
  if (args.poKey !== undefined && args.devKey !== undefined) {
    const links = await getLinkedIssues(args.poKey);
    const match = links.find((l) => l.linkId === args.linkId);
    if (!match) {
      // No DELETE issued — matches §4.17's "missing key → []" resilience convention.
      return {
        linkId: args.linkId,
        deleted: false,
        alreadyGone: true,
        poKey: args.poKey,
        devKey: args.devKey,
      };
    }
    if (match.key !== args.devKey) {
      // A stale UI must never delete an unrelated link.
      throw new UpstreamError(
        `Link ${args.linkId} does not connect ${args.poKey} and ${args.devKey} — refresh and try again`,
        409
      );
    }
  }

  const deleted = await deleteIssueLink(args.linkId);
  return {
    linkId: args.linkId,
    deleted,
    alreadyGone: !deleted,
    ...(args.poKey ? { poKey: args.poKey } : {}),
    ...(args.devKey ? { devKey: args.devKey } : {}),
  };
}

export const unlinkDevFromPo: ToolDef = {
  name: "unlink_dev_from_po",
  description:
    "Remove a PO↔Dev issue link by linkId (from get_linked_issues). When poKey and devKey are " +
    "both supplied (the Linking UI always sends them), the link is first verified to actually " +
    "connect that pair — a match on a different devKey throws 409 UPSTREAM so a stale UI never " +
    "deletes an unrelated link; no match at all returns alreadyGone:true with no DELETE issued. " +
    "A 404 from Jira on delete is treated as success (alreadyGone:true) — Jira returns 404 both " +
    "when the link is already gone and when the caller cannot see it.",
  schema,
  handler,
};
