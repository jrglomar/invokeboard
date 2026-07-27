/**
 * link_dev_to_po tool (v1.72, ADR-083).
 *
 * Before v1.72 a PO↔Dev link could only be born inside create_dev_ticket, so a Dev
 * ticket that already existed could never be attached to its PO story. This is that
 * missing write path — the Linking page's "Link existing" and "New PO from Dev tasks"
 * modes both call it, one pair per call (the client loops for bulk).
 *
 * Deliberately NOT a generic link_issues({ inwardKey, outwardKey }): the direction
 * invariant below is the most error-prone thing in this subsystem (it shipped
 * backwards once and was swapped in v1.42), and a generic tool re-exports that trap
 * to every caller, including Copilot over stdio which has no UI to get it right.
 */

import { z } from "zod";
import type { ToolDef } from "../lib/toolDef.js";
import { getConfig } from "../lib/config.js";
import { createIssueLink, getLinkedIssues } from "../lib/jiraClient.js";

// Reuses the same ticketKey regex as update_ticket (§4.4).
const TICKET_KEY_REGEX = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

// Tool-facing schema stays a plain ZodObject (needed for JSON-Schema generation); the
// poKey !== devKey rule is enforced by a refined variant in the handler (the
// updateTicket/setLeaves pattern).
const schema = z.object({
  poKey: z
    .string()
    .regex(TICKET_KEY_REGEX, "poKey must match PROJECT-NUMBER format"),
  devKey: z
    .string()
    .regex(TICKET_KEY_REGEX, "devKey must match PROJECT-NUMBER format"),
});

const validated = schema.refine((v) => v.poKey !== v.devKey, {
  message: "poKey and devKey must be different tickets",
  path: ["devKey"],
});

interface LinkDevToPoOutput {
  poKey: string;
  devKey: string;
  linkTypeName: string;
  created: boolean;
  alreadyLinked: boolean;
  linkId: string | null;
  reversed?: boolean;
  precheckWarning?: string;
}

async function handler(input: unknown): Promise<LinkDevToPoOutput> {
  const args = validated.parse(input);
  const cfg = getConfig();

  // Dedupe pre-check (non-fatal) — a hit skips the POST entirely.
  let precheckWarning: string | undefined;
  try {
    const existing = await getLinkedIssues(args.poKey);
    const found = existing.find(
      (l) => l.key === args.devKey && l.linkTypeName === cfg.JIRA_LINK_TYPE
    );
    if (found) {
      // The canonical v1.42+ payload puts the PO on inwardIssue, so reading the PO's
      // own links returns the Dev ticket on the OUTWARD side (direction === "outward").
      // A direction === "inward" hit here therefore means a pre-v1.42 REVERSED link —
      // still a real link, just asserting the dependency backwards — so it's surfaced
      // as `reversed: true` rather than silently treated as the canonical shape.
      return {
        poKey: args.poKey,
        devKey: args.devKey,
        linkTypeName: cfg.JIRA_LINK_TYPE,
        created: false,
        alreadyLinked: true,
        linkId: found.linkId,
        ...(found.direction === "inward" ? { reversed: true } : {}),
      };
    }
  } catch (err) {
    // A broken read must never block a legitimate write — fall through to step 2.
    precheckWarning = err instanceof Error ? err.message : String(err);
  }

  // v1.42 (ADR-046 amended): the PO story must read "depends on" its Dev task(s).
  // Empirically, in this Jira the inwardIssue displays the link type's OUTWARD
  // description ("depends on"), so the PO (dependent) goes on inwardKey and the
  // Dev (depended-upon) on outwardKey → "PO depends on Dev". Unlike create_dev_ticket,
  // this call is NOT wrapped in try/catch — the link IS the operation here, not a
  // side-effect of it, so a failure must propagate (502 UPSTREAM).
  await createIssueLink({
    linkTypeName: cfg.JIRA_LINK_TYPE,
    inwardKey: args.poKey,
    outwardKey: args.devKey,
  });

  return {
    poKey: args.poKey,
    devKey: args.devKey,
    linkTypeName: cfg.JIRA_LINK_TYPE,
    created: true,
    alreadyLinked: false,
    linkId: null,
    ...(precheckWarning ? { precheckWarning } : {}),
  };
}

export const linkDevToPo: ToolDef = {
  name: "link_dev_to_po",
  description:
    "Link an EXISTING Dev ticket to an EXISTING PO story using the configured Jira link type " +
    "(JIRA_LINK_TYPE). PO is always the inward issue, Dev the outward issue — the same direction " +
    "create_dev_ticket uses — so the PO reads 'depends on' its Dev task(s). poKey and devKey must " +
    "be different tickets. Dedupes non-fatally: if a link of the configured type already connects " +
    "them, returns alreadyLinked:true with the existing linkId (no duplicate POST); a match found " +
    "on the reversed (pre-v1.42) side is flagged reversed:true. linkId is non-null ONLY on the " +
    "alreadyLinked path — Jira's create response has no body, so the caller refetches " +
    "get_linked_issues after its bulk loop. A link failure THROWS (unlike create_dev_ticket, where " +
    "linking is a side-effect) — here the link is the operation.",
  schema,
  handler,
};
