/**
 * Per-user config resolution (v1.45/v1.46/v1.73, ADR-055/056/084). Builds a full `Config` for a
 * signed-in user by merging, later-wins:
 *
 *   .env base  ←  admin GLOBAL defaults  ←  team config  ←  credential source's overrides  ←
 *   the user's own overrides  ←  the effective Jira credentials  ←  the effective AI credentials
 *
 * "Effective" means: the user's own connection if they have one, otherwise the connection borrowed
 * from their credential source (ADR-056). A borrower also reads the source's local team stores and
 * is read-only against Jira unless an admin granted `allowWrites`.
 *
 * v1.73 (ADR-084): a user's `teamId`, when it resolves to a live team, WINS for storage scope over
 * `sharedFrom ?? userId` — every member of the same team reads/writes the same shared documents.
 * Team scope is orthogonal to credential delegation: `sharedFrom` still decides which Jira/GitHub/AI
 * credentials are in play, independent of team membership.
 *
 * Called by the bridge middleware BEFORE entering the request context, so `getConfig()` here
 * returns the global `.env` base (no ALS context active yet).
 */

import type { Config } from "./config.js";
import { getConfig } from "./config.js";
import { findUserById, findTeamById, teamScope, getGlobalConfig, getUserConfig } from "./userStore.js";
import { getEffectiveConnection, canUserWriteJira, type EffectiveConnection } from "./delegation.js";
import { open } from "./crypto/secretBox.js";

/** Everything the bridge middleware needs to scope a request to one user. */
export interface ResolvedUser {
  config: Config;
  /** Whose per-user JSON stores this request reads/writes (the credential owner when borrowing). */
  storeUserId: string;
  /** False when borrowing a Jira token without admin-granted write access. */
  canWriteJira: boolean;
  /** The user id whose Jira credentials are in play, or null when they're the user's own. */
  sharedFromUserId: string | null;
}

/**
 * Resolve a signed-in user into a request scope, or null when they can't be scoped (unknown,
 * disabled, or no Jira connection of their own or inherited) — the caller falls back to `.env`.
 */
export function resolveUser(userId: string): ResolvedUser | null {
  const user = findUserById(userId);
  if (!user || user.disabled) return null;

  const jira = getEffectiveConnection(userId, "jira");
  if (!jira) return null;

  const base = getConfig(); // global .env base (not yet inside a user request context)
  const sharedFrom = jira.viaUserId; // null when the user owns the Jira connection
  // v1.73 (ADR-084): a teamId pointing at a deleted team behaves as "no team" — never throws.
  const team = user.teamId ? findTeamById(user.teamId) : null;
  const storeUserId = team ? teamScope(team.id) : (sharedFrom ?? userId);
  const token = open(jira.conn.enc); // decrypt in-memory only

  const config: Config = {
    ...base,
    ...getGlobalConfig(), // admin global defaults
    ...(team ? team.config : {}), // v1.73 (ADR-084) — team-level board/env defaults
    ...(sharedFrom ? getUserConfig(sharedFrom) : {}), // inherit the credential owner's overrides
    ...getUserConfig(userId), // the user's own admin-set overrides win
    JIRA_BASE_URL: jira.conn.meta["baseUrl"] || base.JIRA_BASE_URL,
    JIRA_EMAIL: jira.conn.meta["email"] || base.JIRA_EMAIL,
    JIRA_API_TOKEN: token,
    ...resolveAiOverrides(userId, base),
  };

  return {
    config,
    storeUserId,
    canWriteJira: canUserWriteJira(user, jira),
    sharedFromUserId: sharedFrom,
  };
}

/**
 * Merged Config for a user, or null when they have no usable Jira connection.
 * Thin wrapper over `resolveUser` for callers that only need the config.
 */
export function resolveUserConfig(userId: string): Config | null {
  return resolveUser(userId)?.config ?? null;
}

/** The user's effective AI secret → the AI fields getAiProvider() reads. Empty when none. */
function resolveAiOverrides(userId: string, base: Config): Partial<Config> {
  const ai: EffectiveConnection | null = getEffectiveConnection(userId, "ai");
  if (!ai) return {};
  const aiToken = open(ai.conn.enc);
  const provider = ai.conn.meta["provider"];
  const model = (ai.conn.meta["model"] || "").trim();
  if (provider === "anthropic") {
    return { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: aiToken, ANTHROPIC_MODEL: model || base.ANTHROPIC_MODEL };
  }
  if (provider === "github") {
    return { AI_PROVIDER: "github", GITHUB_MODELS_TOKEN: aiToken, GITHUB_MODELS_MODEL: model || base.GITHUB_MODELS_MODEL };
  }
  return {};
}
