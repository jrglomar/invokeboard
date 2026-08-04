/**
 * User store (v1.44, ADR-054) — host-local JSON file for Task Helper accounts + their
 * encrypted Jira/GitHub connections. Mirrors the §4 store pattern (tolerant read → {}).
 * Raw tokens are stored ONLY sealed (AES-256-GCM); this module never returns plaintext —
 * decryption happens in the caller via secretBox.open().
 *
 * v1.65 (ADR-077): reads/writes go through the storage port, always at SHARED_SCOPE — this
 * store is the ONE global account list, never per-user-scoped, even when called from inside
 * a per-user request context (an admin managing users while signed in still reads/writes the
 * same shared "users" doc). Still honors TASK_HELPER_FILE under the json driver.
 */

import * as crypto from "crypto";
import { readDoc, writeDoc, SHARED_SCOPE } from "./storage/index.js";
import type { SealedSecret } from "./crypto/secretBox.js";
import type { AdminConfig } from "./adminConfig.js";

export type ConnectionProvider = "jira" | "github" | "ai";

/** v1.45 (ADR-055) — "admin" unlocks the super-admin console; ADMIN_EMAILS bootstraps admins. */
export type UserRole = "admin" | "user";

export interface StoredUser {
  id: string;
  email: string; // normalized lowercase
  passwordHash: string;
  role: UserRole; // v1.45 (ADR-055)
  createdAt: string; // ISO
  /**
   * v1.46 (ADR-056) — SHARED CREDENTIALS. When set, this user has no tokens of their own and
   * borrows the named user's Jira/GitHub/AI connections (and their local stores + config).
   * null/absent = the user uses their own connections.
   */
  credentialSourceUserId?: string | null;
  /** v1.46 — admin opt-in: allow a shared-credential user to MUTATE Jira (as the token owner). */
  allowWrites?: boolean;
  /** v1.46 — a disabled account cannot sign in and its sessions are rejected. */
  disabled?: boolean;
  /**
   * v1.67 (ADR-078) — GRANULAR sharing. undefined/absent = legacy "share ALL providers this user
   * doesn't own" (unchanged default behavior for every existing shared account). An explicit array
   * restricts fallback-sharing to only the listed providers — a provider left out never borrows the
   * source's connection, even if the source has one; it shows as disconnected instead.
   */
  sharedProviders?: ConnectionProvider[];
  /**
   * v1.73 (ADR-084) — TEAM SCOPE. When set, this user's shared documents (leaves, retro, meeting
   * notes, impediments, offset, prs, post-scrum, meeting-goal, team, draft-plan) live at the team's
   * scope instead of `sharedFrom ?? userId` — every member of the same team reads/writes the SAME
   * documents. Orthogonal to `credentialSourceUserId`: team decides SCOPE, delegation still decides
   * CREDENTIALS. null/absent = the user has no team (falls back to the ADR-056 rule).
   */
  teamId?: string | null;
}

/** Fields an admin may set when creating/updating a user (never the password hash directly). */
export interface UserPatch {
  email?: string;
  passwordHash?: string;
  role?: UserRole;
  credentialSourceUserId?: string | null;
  allowWrites?: boolean;
  disabled?: boolean;
  /** v1.67 (ADR-078) — null clears the restriction back to share-all, same convention as above. */
  sharedProviders?: ConnectionProvider[] | null;
  /** v1.73 (ADR-084) — null clears team membership, same null-clears convention as above. */
  teamId?: string | null;
}

/** A stored connection: the sealed token + non-secret masked metadata (safe to surface). */
export interface StoredConnection {
  enc: SealedSecret;
  meta: Record<string, string>; // e.g. { baseUrl, email, hint } (jira) / { login, hint } (github)
  updatedAt: string; // ISO
}

/**
 * v1.47 (ADR-057) — a NAMED, reusable bundle of admin config. An admin builds a template once
 * (e.g. "Dev board — Team A") and applies it to any user's overrides or to the global defaults.
 */
export interface ConfigTemplate {
  id: string;
  name: string;
  config: AdminConfig;
  createdAt: string;
  updatedAt: string;
}

/**
 * v1.73 (ADR-084) — a shared TEAM SCOPE. Every user with `StoredUser.teamId` set to this team's id
 * reads/writes the same shared documents (leaves, retro, meeting notes, impediments, offset, prs,
 * post-scrum, meeting-goal, team, draft-plan) while keeping their own Jira/GitHub/AI credentials.
 * `config` is a team-level admin-config layer (see userConfig.ts's merge order).
 */
export interface Team {
  id: string;
  name: string;
  config: AdminConfig;
  createdAt: string;
  updatedAt: string;
}

interface UserStoreFile {
  users: Record<string, StoredUser>; // keyed by user id
  connections: Record<string, Partial<Record<ConnectionProvider, StoredConnection>>>; // keyed by user id
  globalConfig: AdminConfig; // v1.45 (ADR-055) — admin-set defaults for everyone
  userConfigs: Record<string, AdminConfig>; // v1.45 — admin-set per-user overrides, keyed by user id
  configTemplates: Record<string, ConfigTemplate>; // v1.47 (ADR-057) — reusable config bundles
  teams: Record<string, Team>; // v1.73 (ADR-084) — shared team scopes, keyed by team id
}

function emptyStore(): UserStoreFile {
  return { users: {}, connections: {}, globalConfig: {}, userConfigs: {}, configTemplates: {}, teams: {} };
}

/** Legacy records (pre-v1.45) have no `role` — default them to "user" on read. */
function backfillRoles(users: Record<string, StoredUser>): Record<string, StoredUser> {
  for (const u of Object.values(users)) {
    if (u.role !== "admin" && u.role !== "user") u.role = "user";
  }
  return users;
}

function read(): UserStoreFile {
  const parsed = readDoc(SHARED_SCOPE, "users");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyStore();
  const obj = parsed as Partial<UserStoreFile>;
  return {
    users: backfillRoles(obj.users ?? {}),
    connections: obj.connections ?? {},
    globalConfig: obj.globalConfig ?? {},
    userConfigs: obj.userConfigs ?? {},
    configTemplates: obj.configTemplates ?? {},
    teams: obj.teams ?? {}, // v1.73 (ADR-084) — legacy docs have no `teams` key
  };
}

function write(data: UserStoreFile): void {
  writeDoc(SHARED_SCOPE, "users", data);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── Users ─────────────────────────────────────────────────────────────────────

export function findUserByEmail(email: string): StoredUser | null {
  const norm = normalizeEmail(email);
  const { users } = read();
  return Object.values(users).find((u) => u.email === norm) ?? null;
}

export function findUserById(id: string): StoredUser | null {
  return read().users[id] ?? null;
}

/** Create a user. Caller must have checked the email is free (route returns 409 otherwise). */
export function createUser(
  email: string,
  passwordHash: string,
  role: UserRole = "user",
  extras: Pick<UserPatch, "credentialSourceUserId" | "allowWrites" | "disabled"> & {
    sharedProviders?: ConnectionProvider[];
  } = {}
): StoredUser {
  const data = read();
  const user: StoredUser = {
    id: crypto.randomUUID(),
    email: normalizeEmail(email),
    passwordHash,
    role,
    createdAt: new Date().toISOString(),
    ...(extras.credentialSourceUserId ? { credentialSourceUserId: extras.credentialSourceUserId } : {}),
    ...(extras.allowWrites !== undefined ? { allowWrites: extras.allowWrites } : {}),
    ...(extras.disabled !== undefined ? { disabled: extras.disabled } : {}),
    ...(extras.sharedProviders !== undefined ? { sharedProviders: extras.sharedProviders } : {}),
  };
  data.users[user.id] = user;
  write(data);
  return user;
}

/** All users, oldest first — for the admin supervision view. */
export function listUsers(): StoredUser[] {
  return Object.values(read().users).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Set a user's stored role (admin promotion/demotion via the console). */
export function setUserRole(id: string, role: UserRole): StoredUser | null {
  return updateUser(id, { role });
}

/** v1.46 — patch a user. `credentialSourceUserId: null` clears the delegation. */
export function updateUser(id: string, patch: UserPatch): StoredUser | null {
  const data = read();
  const user = data.users[id];
  if (!user) return null;
  if (patch.email !== undefined) user.email = normalizeEmail(patch.email);
  if (patch.passwordHash !== undefined) user.passwordHash = patch.passwordHash;
  if (patch.role !== undefined) user.role = patch.role;
  if (patch.allowWrites !== undefined) user.allowWrites = patch.allowWrites;
  if (patch.disabled !== undefined) user.disabled = patch.disabled;
  if (patch.credentialSourceUserId !== undefined) {
    if (patch.credentialSourceUserId === null) delete user.credentialSourceUserId;
    else user.credentialSourceUserId = patch.credentialSourceUserId;
  }
  if (patch.sharedProviders !== undefined) {
    if (patch.sharedProviders === null) delete user.sharedProviders;
    else user.sharedProviders = patch.sharedProviders;
  }
  if (patch.teamId !== undefined) {
    if (patch.teamId === null) delete user.teamId;
    else user.teamId = patch.teamId;
  }
  data.users[id] = user;
  write(data);
  return user;
}

/** v1.46 — hard-delete a user along with their encrypted connections and config overrides. */
export function deleteUser(id: string): boolean {
  const data = read();
  if (!data.users[id]) return false;
  delete data.users[id];
  delete data.connections[id];
  delete data.userConfigs[id];
  write(data);
  return true;
}

/** v1.46 — everyone who borrows this user's credentials (blocks deleting a credential source). */
export function listUsersByCredentialSource(sourceId: string): StoredUser[] {
  return Object.values(read().users).filter((u) => u.credentialSourceUserId === sourceId);
}

/** v1.73 (ADR-084) — everyone on this team (blocks deleting a team while members remain). */
export function listUsersByTeam(teamId: string): StoredUser[] {
  return Object.values(read().users).filter((u) => u.teamId === teamId);
}

// ── Admin config (v1.45, ADR-055) — global defaults + per-user overrides ────────

export function getGlobalConfig(): AdminConfig {
  return read().globalConfig;
}

export function setGlobalConfig(cfg: AdminConfig): void {
  const data = read();
  data.globalConfig = cfg;
  write(data);
}

export function getUserConfig(userId: string): AdminConfig {
  return read().userConfigs[userId] ?? {};
}

export function setUserConfig(userId: string, cfg: AdminConfig): void {
  const data = read();
  data.userConfigs[userId] = cfg;
  write(data);
}

// ── Config templates (v1.47, ADR-057) — reusable named config bundles ──────────

export function listConfigTemplates(): ConfigTemplate[] {
  return Object.values(read().configTemplates).sort((a, b) => a.name.localeCompare(b.name));
}

export function findConfigTemplateByName(name: string): ConfigTemplate | null {
  const norm = name.trim().toLowerCase();
  return listConfigTemplates().find((t) => t.name.toLowerCase() === norm) ?? null;
}

export function findConfigTemplateById(id: string): ConfigTemplate | null {
  return read().configTemplates[id] ?? null;
}

export function createConfigTemplate(name: string, config: AdminConfig): ConfigTemplate {
  const data = read();
  const now = new Date().toISOString();
  const tpl: ConfigTemplate = { id: crypto.randomUUID(), name: name.trim(), config, createdAt: now, updatedAt: now };
  data.configTemplates[tpl.id] = tpl;
  write(data);
  return tpl;
}

export function updateConfigTemplate(
  id: string,
  patch: { name?: string; config?: AdminConfig }
): ConfigTemplate | null {
  const data = read();
  const tpl = data.configTemplates[id];
  if (!tpl) return null;
  if (patch.name !== undefined) tpl.name = patch.name.trim();
  if (patch.config !== undefined) tpl.config = patch.config;
  tpl.updatedAt = new Date().toISOString();
  data.configTemplates[id] = tpl;
  write(data);
  return tpl;
}

export function deleteConfigTemplate(id: string): boolean {
  const data = read();
  if (!data.configTemplates[id]) return false;
  delete data.configTemplates[id];
  write(data);
  return true;
}

// ── Teams (v1.73, ADR-084) ──────────────────────────────────────────────────

/**
 * The scope a team's shared documents live at. Must stay filesystem-safe — the json driver turns a
 * scope string directly into a directory name — so the `team-` prefix is deliberate (no character a
 * Windows path component disallows, unlike e.g. `team:<id>`) and disjoint from any user id
 * (`crypto.randomUUID()` values never start with `team-`).
 */
export function teamScope(teamId: string): string {
  return `team-${teamId}`;
}

export function listTeams(): Team[] {
  return Object.values(read().teams).sort((a, b) => a.name.localeCompare(b.name));
}

export function findTeamById(id: string): Team | null {
  return read().teams[id] ?? null;
}

export function findTeamByName(name: string): Team | null {
  const norm = name.trim().toLowerCase();
  return listTeams().find((t) => t.name.toLowerCase() === norm) ?? null;
}

export function createTeam(name: string, config: AdminConfig = {}): Team {
  const data = read();
  const now = new Date().toISOString();
  const team: Team = { id: crypto.randomUUID(), name: name.trim(), config, createdAt: now, updatedAt: now };
  data.teams[team.id] = team;
  write(data);
  return team;
}

export function updateTeam(id: string, patch: { name?: string; config?: AdminConfig }): Team | null {
  const data = read();
  const team = data.teams[id];
  if (!team) return null;
  if (patch.name !== undefined) team.name = patch.name.trim();
  if (patch.config !== undefined) team.config = patch.config;
  team.updatedAt = new Date().toISOString();
  data.teams[id] = team;
  write(data);
  return team;
}

export function deleteTeam(id: string): boolean {
  const data = read();
  if (!data.teams[id]) return false;
  delete data.teams[id];
  write(data);
  return true;
}

// ── Connections ─────────────────────────────────────────────────────────────

export function getConnection(userId: string, provider: ConnectionProvider): StoredConnection | null {
  return read().connections[userId]?.[provider] ?? null;
}

export function upsertConnection(
  userId: string,
  provider: ConnectionProvider,
  conn: StoredConnection
): void {
  const data = read();
  const forUser = data.connections[userId] ?? {};
  forUser[provider] = conn;
  data.connections[userId] = forUser;
  write(data);
}

export function deleteConnection(userId: string, provider: ConnectionProvider): void {
  const data = read();
  const forUser = data.connections[userId];
  if (forUser && forUser[provider]) {
    delete forUser[provider];
    data.connections[userId] = forUser;
    write(data);
  }
}
