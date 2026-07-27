/**
 * Shared credentials / delegation (v1.46, ADR-056).
 *
 * A teammate can be onboarded with NO tokens of their own: an admin points their account at a
 * "credential source" user (typically the admin). Their requests then run on the source's
 * Jira/GitHub/AI connections, read the source's local team stores, and inherit the source's
 * board/env overrides — a shared point-of-view onto the same board.
 *
 * Safety: a Jira MUTATION made on a borrowed token is attributed to the token's owner in Jira's
 * history. So a borrower is READ-ONLY against Jira unless an admin explicitly sets `allowWrites`.
 * Delegation is never chained (a source must own its credentials), so there's no resolution cycle.
 *
 * v1.67 (ADR-078): sharing is now GRANULAR per provider. `StoredUser.sharedProviders` — when set —
 * restricts which providers may fall back to the source; a provider left off the list resolves to
 * null (disconnected) rather than silently borrowing. Absent = legacy share-all (backward compatible).
 */

import { getConnection, findUserById, type StoredConnection, type ConnectionProvider, type StoredUser } from "./userStore.js";

/** A connection resolved for a user — either their own, or borrowed via `viaUserId`. */
export interface EffectiveConnection {
  conn: StoredConnection;
  /** null when the user owns this connection; otherwise the id of the user it was borrowed from. */
  viaUserId: string | null;
}

/**
 * The connection this user effectively uses for `provider`: their own if present, else the one
 * belonging to their credential source. Resolves at most ONE hop (sources own their credentials).
 */
export function getEffectiveConnection(
  userId: string,
  provider: ConnectionProvider
): EffectiveConnection | null {
  const own = getConnection(userId, provider);
  if (own) return { conn: own, viaUserId: null };

  const user = findUserById(userId);
  const sourceId = user?.credentialSourceUserId;
  if (!sourceId) return null;

  // v1.67 (ADR-078) — granular sharing: an explicit `sharedProviders` list restricts fallback to
  // only the named providers. undefined (the legacy default) shares ALL providers, unchanged.
  if (user!.sharedProviders !== undefined && !user!.sharedProviders.includes(provider)) return null;

  const shared = getConnection(sourceId, provider);
  return shared ? { conn: shared, viaUserId: sourceId } : null;
}

/** True when this user is configured to borrow someone else's credentials. */
export function isDelegated(user: StoredUser): boolean {
  return typeof user.credentialSourceUserId === "string" && user.credentialSourceUserId !== "";
}

/**
 * May this user mutate Jira? Yes when the Jira connection in play is their OWN (they act as
 * themselves). When they're borrowing a token, only if an admin granted `allowWrites`.
 */
export function canUserWriteJira(user: StoredUser, jira: EffectiveConnection | null): boolean {
  if (!jira || jira.viaUserId === null) return true; // own token (or nothing to write with)
  return user.allowWrites === true;
}

/**
 * Tools that MUTATE Jira. A borrower without `allowWrites` is blocked from these — the change
 * would land in Jira under the token owner's name.
 *
 * NOTE: the other `set_*` tools write LOCAL team JSON stores (leaves, retro, meeting notes,
 * impediments, offset) — not Jira — so they stay available to shared-credential users.
 * Adding a new Jira-mutating tool means adding it here (deliberate, audit-friendly).
 */
export const JIRA_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "create_po_ticket",
  "create_dev_ticket",
  "update_ticket",
  "create_sprint",
  "set_sprint_goal",
  "assign_issue",
  "transition_issue",
  "move_issue_to_sprint",
  "link_dev_to_po",
  "unlink_dev_from_po",
]);
