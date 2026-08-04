/**
 * The 11 store names that have a SHARED-scope presence (i.e. can resolve outside a per-user
 * request context) plus their `*_FILE` env override, if any (v1.65, ADR-077). This is the one
 * place that maps a storage "name" to config.ts's per-store override field — used by the
 * production json driver (index.ts) to stay byte-identical to the pre-port `getXFilePath()`
 * functions, and by autoImport.ts to find each store's current file when scanning for docs to
 * import into sqlite.
 *
 * `journal` is deliberately absent — a journal is ALWAYS per-user (keyed by the real user id,
 * never SHARED_SCOPE) and has no override env var; the json driver's generic per-user path
 * formula already covers it with no registry entry needed.
 */

import { getConfig } from "../config.js";

/** Every store name that can live at SHARED_SCOPE. Order is just for stable log output. */
export const SHARED_STORE_NAMES: readonly string[] = [
  "leaves",
  "team",
  "impediments",
  "prs",
  "post-scrum",
  "meeting-goal",
  "meeting-notes",
  "retro",
  "offset",
  "users",
  "draft-plan",
];

const OVERRIDE_BY_NAME: Record<string, () => string> = {
  leaves: () => getConfig().JIRA_LEAVES_FILE,
  team: () => getConfig().JIRA_TEAM_FILE,
  impediments: () => getConfig().JIRA_IMPEDIMENTS_FILE,
  prs: () => getConfig().JIRA_PRS_FILE,
  "post-scrum": () => getConfig().JIRA_POST_SCRUM_FILE,
  "meeting-goal": () => getConfig().JIRA_MEETING_GOAL_FILE,
  "meeting-notes": () => getConfig().JIRA_MEETING_NOTES_FILE,
  retro: () => getConfig().JIRA_RETRO_FILE,
  offset: () => getConfig().JIRA_OFFSET_FILE,
  users: () => getConfig().TASK_HELPER_FILE,
  "draft-plan": () => getConfig().JIRA_DRAFT_PLAN_FILE,
};

/** Live override lookup (reads config fresh every call — env changes + resetConfigCache apply). */
export function resolveJsonOverride(name: string): string {
  return OVERRIDE_BY_NAME[name]?.() ?? "";
}

/**
 * v1.73 (ADR-084) — the doc names a TEAM shares. Exactly `SHARED_STORE_NAMES` minus `"users"` (the
 * one global account list) — `journal` is absent by design too, since personal notes stay per-user.
 */
export const TEAM_SCOPED_STORE_NAMES: readonly string[] = SHARED_STORE_NAMES.filter(
  (name) => name !== "users"
);
