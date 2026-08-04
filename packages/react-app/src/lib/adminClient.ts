// Admin console client (v1.45, ADR-055 Phase E) — the super-admin API on the mcp-jira bridge.
// All calls are credentialed (session cookie) and require an admin role; the server returns
// 401/403 otherwise. Only NON-secret board/env config is settable here — never tokens.

import { credFetch } from "./authClient";

export type UserRole = "admin" | "user";

/** The non-secret Jira config an admin can set (global defaults or per-user overrides). */
export interface AdminConfig {
  JIRA_BASE_URL?: string;
  JIRA_EMAIL?: string;
  JIRA_PO_PROJECT_KEY?: string;
  JIRA_DEV_PROJECT_KEY?: string;
  JIRA_PO_BOARD_ID?: string;
  JIRA_DEV_BOARD_ID?: string;
  JIRA_PO_PROJECTS?: string;
  JIRA_DEV_PROJECTS?: string;
  JIRA_STORY_POINTS_FIELD?: string;
  JIRA_LINK_TYPE?: string;
  JIRA_FLAGGED_FIELD?: string;
  JIRA_CODE_REVIEW_STATUSES?: string;
  JIRA_DEV_STATUS_APP_TYPE?: string;
  JIRA_VELOCITY_SPRINTS?: number;
  JIRA_REQUIRED_POINTS?: number;
  JIRA_OFFSET_THRESHOLD?: number;
  // v1.58 (ADR-070) — ticket-aging expectation policy (mirrors mcp-jira's adminConfigSchema).
  JIRA_AGING_BASE_DAYS?: number;
  JIRA_AGING_DAYS_PER_POINT?: number;
}

/** v1.67 (ADR-078) — per-provider status: the user's OWN connection, one INHERITED via a source
 * user's email, or NONE (absent, or explicitly not shared to this user via `sharedProviders`). */
export type ProviderStatus = { status: "own" } | { status: "inherited"; via: string } | { status: "none" };

export interface AdminUser {
  id: string;
  email: string;
  role: UserRole;
  /** Admin via ADMIN_EMAILS — authoritative, can't be demoted/disabled/deleted via the API. */
  bootstrapAdmin: boolean;
  createdAt: string;
  /** The user's OWN connections (false for a user running purely on shared credentials). */
  connections: { jira: boolean; github: boolean; ai: boolean };
  /** v1.67 (ADR-078) — own / inherited-via / none per provider (distinguishes borrowed from absent). */
  effective: { jira: ProviderStatus; github: ProviderStatus; ai: ProviderStatus };
  config: AdminConfig; // this user's per-user overrides
  // ── v1.46 (ADR-056) shared credentials ──
  /** The user whose Jira/GitHub/AI this account borrows, or null when it uses its own. */
  credentialSourceUserId: string | null;
  /** Email of the credential source, or null. */
  sharedFrom: string | null;
  /** Admin opt-in: may a borrower mutate Jira (writes land under the owner's name)? */
  allowWrites: boolean;
  disabled: boolean;
  /** v1.67 (ADR-078) — null/absent = share ALL providers the user doesn't own (legacy default);
   * an explicit array restricts fallback-sharing to only the listed providers. */
  sharedProviders: ("jira" | "github" | "ai")[] | null;
  /** Effective: borrowing Jira without write access. */
  readOnly: boolean;
  /** May lend credentials to others (owns a Jira connection, borrows from nobody). */
  canBeSource: boolean;
  /** v1.73 (ADR-084) — the team this user belongs to (storage SCOPE only; orthogonal to credentials). */
  teamId: string | null;
  teamName: string | null;
}

export interface AdminUsersResponse {
  users: AdminUser[];
  globalConfig: AdminConfig;
}

/** Fields accepted when an admin creates a user. */
export interface CreateUserInput {
  email: string;
  password: string;
  role?: UserRole;
  credentialSourceUserId?: string;
  allowWrites?: boolean;
  /** v1.67 (ADR-078) — restrict fallback-sharing to only these providers. Omitted = share all. */
  sharedProviders?: ("jira" | "github" | "ai")[];
}

/** Fields accepted when an admin updates a user. `credentialSourceUserId: null` clears sharing. */
export interface UpdateUserInput {
  email?: string;
  password?: string;
  credentialSourceUserId?: string | null;
  allowWrites?: boolean;
  disabled?: boolean;
  /** v1.67 (ADR-078) — null clears the restriction back to share-all. */
  sharedProviders?: ("jira" | "github" | "ai")[] | null;
}

export function getAdminUsers(): Promise<AdminUsersResponse> {
  return credFetch<AdminUsersResponse>("/api/admin/users", "GET");
}

export function putGlobalConfig(config: AdminConfig): Promise<{ globalConfig: AdminConfig }> {
  return credFetch<{ globalConfig: AdminConfig }>("/api/admin/config", "PUT", config);
}

export function putUserConfig(userId: string, config: AdminConfig): Promise<AdminUser> {
  return credFetch<AdminUser>(`/api/admin/users/${userId}/config`, "PUT", config);
}

export function putUserRole(userId: string, role: UserRole): Promise<AdminUser> {
  return credFetch<AdminUser>(`/api/admin/users/${userId}/role`, "PUT", { role });
}

// ── v1.46 (ADR-056) — user CRUD ────────────────────────────────────────────────

export function createUser(input: CreateUserInput): Promise<AdminUser> {
  return credFetch<AdminUser>("/api/admin/users", "POST", input);
}

export function updateUser(userId: string, input: UpdateUserInput): Promise<AdminUser> {
  return credFetch<AdminUser>(`/api/admin/users/${userId}`, "PUT", input);
}

export function deleteUser(userId: string): Promise<{ deleted: boolean; id: string }> {
  return credFetch<{ deleted: boolean; id: string }>(`/api/admin/users/${userId}`, "DELETE");
}

// ── v1.47 (ADR-057) — reusable config templates ───────────────────────────────

/** A named, reusable bundle of admin config, applicable to any user or to the global defaults. */
export interface ConfigTemplate {
  id: string;
  name: string;
  config: AdminConfig;
  createdAt: string;
  updatedAt: string;
}

export function getTemplates(): Promise<{ templates: ConfigTemplate[] }> {
  return credFetch<{ templates: ConfigTemplate[] }>("/api/admin/templates", "GET");
}

export function createTemplate(name: string, config: AdminConfig): Promise<ConfigTemplate> {
  return credFetch<ConfigTemplate>("/api/admin/templates", "POST", { name, config });
}

export function updateTemplate(id: string, patch: { name?: string; config?: AdminConfig }): Promise<ConfigTemplate> {
  return credFetch<ConfigTemplate>(`/api/admin/templates/${id}`, "PUT", patch);
}

export function deleteTemplate(id: string): Promise<{ deleted: boolean }> {
  return credFetch<{ deleted: boolean }>(`/api/admin/templates/${id}`, "DELETE");
}

/** Apply a template to a user's overrides. `merge` layers it over what's set; default replaces. */
export function applyTemplateToUser(userId: string, templateId: string, merge = false): Promise<AdminUser> {
  return credFetch<AdminUser>(`/api/admin/users/${userId}/config/apply-template`, "POST", { templateId, merge });
}

/** Apply a template to the global defaults. */
export function applyTemplateToGlobal(templateId: string, merge = false): Promise<{ globalConfig: AdminConfig }> {
  return credFetch<{ globalConfig: AdminConfig }>("/api/admin/config/apply-template", "POST", { templateId, merge });
}

// ── v1.73 (ADR-084) — Teams: a shared team scope ──────────────────────────────
// A team is a THIRD scope input (independent of credential delegation, ADR-056): every member
// assigned to the same team reads/writes the SAME leaves/retro/meeting-notes/etc., while each still
// authenticates with their own Jira/GitHub/AI. See CONTRACTS.md §9.10 / ADR-084.

export interface TeamMemberRef {
  id: string;
  email: string;
}

/** Safe-to-surface admin view of a team — identity + resolved membership, no secrets. */
export interface TeamView {
  id: string;
  name: string;
  config: AdminConfig; // team-level board/env defaults — sits between global defaults and per-user overrides
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  members: TeamMemberRef[];
}

/** Result of a one-time adopt (seed): which team-scoped docs were copied vs. already present/absent. */
export interface AdoptResult {
  copied: string[];
  skipped: string[];
}

export function listTeams(): Promise<{ teams: TeamView[] }> {
  return credFetch<{ teams: TeamView[] }>("/api/admin/teams", "GET");
}

export function createTeam(name: string, config?: AdminConfig): Promise<TeamView> {
  return credFetch<TeamView>("/api/admin/teams", "POST", { name, config });
}

export function updateTeam(id: string, patch: { name?: string; config?: AdminConfig }): Promise<TeamView> {
  return credFetch<TeamView>(`/api/admin/teams/${id}`, "PUT", patch);
}

export function deleteTeam(id: string): Promise<{ deleted: boolean }> {
  return credFetch<{ deleted: boolean }>(`/api/admin/teams/${id}`, "DELETE");
}

/** Assign (or clear, with `teamId: null`) the team a user belongs to — storage SCOPE only. */
export function setUserTeam(userId: string, teamId: string | null): Promise<AdminUser> {
  return credFetch<AdminUser>(`/api/admin/users/${userId}/team`, "PUT", { teamId });
}

/**
 * One-time, non-destructive seed: copies `fromUserId`'s existing personal documents into the team's
 * shared scope. Never overwrites a document the team already has — safe to run more than once.
 */
export function adoptIntoTeam(teamId: string, fromUserId: string): Promise<AdoptResult> {
  return credFetch<AdoptResult>(`/api/admin/teams/${teamId}/adopt`, "POST", { fromUserId });
}
