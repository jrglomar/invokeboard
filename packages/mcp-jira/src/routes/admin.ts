/**
 * Admin router (v1.45, ADR-055 Phase B) — the super-admin console API. Mounted on the mcp-jira
 * bridge at root; every route is guarded by `requireAdmin`. Lets a super-admin:
 *   - list + supervise all users (role, connection status, assigned board config),
 *   - set GLOBAL board/env defaults (applied to every user), and
 *   - set PER-USER board/env overrides,
 *   - promote/demote roles.
 *
 * Secrets (Jira/GitHub/AI tokens) are the user's OWN encrypted connections and are NEVER exposed
 * or settable here — the admin only configures the non-secret Jira tuning block (see adminConfig).
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { z, ZodError } from "zod";
import { isTaskHelperConfigured, isAdminEmail } from "../lib/config.js";
import { requireAdmin, isAdmin } from "../lib/auth/adminMiddleware.js";
import {
  listUsers, findUserById, findUserByEmail, setUserRole, createUser, updateUser, deleteUser,
  listUsersByCredentialSource,
  getGlobalConfig, setGlobalConfig, getUserConfig, setUserConfig, getConnection,
  listConfigTemplates, createConfigTemplate, updateConfigTemplate, deleteConfigTemplate,
  findConfigTemplateByName, findConfigTemplateById,
  listTeams, findTeamById, findTeamByName, createTeam, updateTeam, deleteTeam, listUsersByTeam, teamScope,
  type StoredUser, type Team,
} from "../lib/userStore.js";
import { adminConfigSchema } from "../lib/adminConfig.js";
import { hashPassword } from "../lib/auth/password.js";
import { isDelegated, getEffectiveConnection } from "../lib/delegation.js";
import { TEAM_SCOPED_STORE_NAMES } from "../lib/storage/registry.js";
import { adoptScopeDocs } from "../lib/storage/adopt.js";

export const adminRouter = express.Router();

function fail(res: Response, status: number, code: string, message: string, issues?: unknown[]): void {
  const body: { ok: false; error: { code: string; message: string; issues?: unknown[] } } = {
    ok: false,
    error: { code, message },
  };
  if (issues !== undefined) body.error.issues = issues;
  res.status(status).json(body);
}

// Enablement guard scoped to /api/admin (router is mounted at root, so a blanket guard would
// wrongly intercept /api/tools, /api/health, etc. — same pattern as the Task Helper router).
adminRouter.use("/api/admin", (_req: Request, res: Response, next: NextFunction) => {
  if (!isTaskHelperConfigured()) {
    fail(res, 503, "TASK_HELPER_UNAVAILABLE", "Admin console is disabled — set TOKEN_ENC_KEY and SESSION_SECRET");
    return;
  }
  next();
});

/** Which providers a user has connected (booleans only — never any token). */
function connFlags(userId: string) {
  return {
    jira: !!getConnection(userId, "jira"),
    github: !!getConnection(userId, "github"),
    ai: !!getConnection(userId, "ai"),
  };
}

/**
 * v1.67 (ADR-078) — per-provider status the admin console can render at a glance: the user's OWN
 * connection, one INHERITED from a credential source (with the source's email), or NONE — distinct
 * from the `connections` (own-only) flags, which can't tell "borrowed" apart from "absent".
 */
type ProviderStatus = { status: "own" } | { status: "inherited"; via: string } | { status: "none" };

function effectiveStatus(userId: string, provider: "jira" | "github" | "ai"): ProviderStatus {
  const eff = getEffectiveConnection(userId, provider);
  if (!eff) return { status: "none" };
  if (eff.viaUserId === null) return { status: "own" };
  return { status: "inherited", via: findUserById(eff.viaUserId)?.email ?? "" };
}

/** Safe-to-surface admin view of a user (no secrets). */
function userView(u: StoredUser) {
  const sourceId = u.credentialSourceUserId ?? null;
  const own = connFlags(u.id);
  return {
    id: u.id,
    email: u.email,
    role: isAdmin(u) ? "admin" : "user",
    bootstrapAdmin: isAdminEmail(u.email), // admin via ADMIN_EMAILS → can't be demoted here
    createdAt: u.createdAt,
    connections: own, // the user's OWN connections (not the borrowed ones)
    // v1.67 (ADR-078) — own / inherited-via / none per provider, so the admin can tell a borrowed
    // token apart from a genuinely absent one at a glance.
    effective: {
      jira: effectiveStatus(u.id, "jira"),
      github: effectiveStatus(u.id, "github"),
      ai: effectiveStatus(u.id, "ai"),
    },
    config: getUserConfig(u.id), // admin-set per-user overrides (non-secret)
    // v1.46 (ADR-056) — shared credentials
    credentialSourceUserId: sourceId,
    sharedFrom: sourceId ? (findUserById(sourceId)?.email ?? "") : null,
    allowWrites: u.allowWrites === true,
    disabled: u.disabled === true,
    /** v1.67 (ADR-078) — undefined/absent = legacy share-all; an explicit array restricts it. */
    sharedProviders: u.sharedProviders ?? null,
    /** Effective: a borrower can't mutate Jira unless allowWrites. */
    readOnly: sourceId !== null && !own.jira && u.allowWrites !== true,
    /** Eligible to lend credentials to others: owns a Jira connection and borrows from nobody. */
    canBeSource: own.jira && sourceId === null,
    // v1.73 (ADR-084) — the team this user belongs to (storage SCOPE only; orthogonal to credentials).
    teamId: u.teamId ?? null,
    teamName: u.teamId ? (findTeamById(u.teamId)?.name ?? null) : null,
  };
}

/** Safe-to-surface admin view of a team (v1.73, ADR-084). */
function teamView(t: Team) {
  const members = listUsersByTeam(t.id)
    .map((u) => ({ id: u.id, email: u.email }))
    .sort((a, b) => a.email.localeCompare(b.email));
  return {
    id: t.id,
    name: t.name,
    config: t.config,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    memberCount: members.length,
    members,
  };
}

/**
 * A credential source must exist, not be the target, own its OWN Jira connection, and not itself
 * be a borrower — delegation is exactly one hop, so resolution can never cycle.
 */
function invalidSourceReason(targetId: string, sourceId: string): string | null {
  if (sourceId === targetId) return "A user cannot share credentials with themselves";
  const source = findUserById(sourceId);
  if (!source) return "Credential source user not found";
  if (isDelegated(source)) return "That user borrows credentials themselves — pick a user who owns their Jira token";
  if (!getConnection(sourceId, "jira")) return "That user has no Jira connection to share";
  return null;
}

// GET /api/admin/users — all users + the global config (the supervision view).
adminRouter.get("/api/admin/users", requireAdmin, (_req: Request, res: Response) => {
  res.json({ ok: true, data: { users: listUsers().map(userView), globalConfig: getGlobalConfig() } });
});

// GET /api/admin/config — the global default board/env config.
adminRouter.get("/api/admin/config", requireAdmin, (_req: Request, res: Response) => {
  res.json({ ok: true, data: { globalConfig: getGlobalConfig() } });
});

// PUT /api/admin/config — replace the global defaults (full replace with the parsed body).
adminRouter.put("/api/admin/config", requireAdmin, (req: Request, res: Response) => {
  let cfg;
  try {
    cfg = adminConfigSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "Invalid config", (err as ZodError).issues);
    return;
  }
  setGlobalConfig(cfg);
  res.json({ ok: true, data: { globalConfig: getGlobalConfig() } });
});

// PUT /api/admin/users/:id/config — replace a user's per-user overrides.
adminRouter.put("/api/admin/users/:id/config", requireAdmin, (req: Request, res: Response) => {
  const target = findUserById(req.params["id"] ?? "");
  if (!target) {
    fail(res, 404, "NOT_FOUND", "User not found");
    return;
  }
  let cfg;
  try {
    cfg = adminConfigSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "Invalid config", (err as ZodError).issues);
    return;
  }
  setUserConfig(target.id, cfg);
  res.json({ ok: true, data: userView(findUserById(target.id) as StoredUser) });
});

// ── User CRUD (v1.46, ADR-056) ────────────────────────────────────────────────

const createUserSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  role: z.enum(["admin", "user"]).optional(),
  /** Borrow this user's Jira/GitHub/AI connections (for teammates with no tokens of their own). */
  credentialSourceUserId: z.string().min(1).optional(),
  /** Let a borrower mutate Jira (writes are attributed to the token owner). */
  allowWrites: z.boolean().optional(),
  /** v1.67 (ADR-078) — restrict fallback-sharing to only these providers. Omitted = share all. */
  sharedProviders: z.array(z.enum(["jira", "github", "ai"])).optional(),
});

// POST /api/admin/users — create an account (optionally on shared credentials).
adminRouter.post("/api/admin/users", requireAdmin, (req: Request, res: Response) => {
  let body;
  try {
    body = createUserSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "email and an 8+ char password are required", (err as ZodError).issues);
    return;
  }
  if (findUserByEmail(body.email)) {
    fail(res, 409, "EMAIL_TAKEN", "An account with that email already exists");
    return;
  }
  if (body.credentialSourceUserId) {
    // The target doesn't exist yet, so pass a sentinel id that can never equal the source.
    const reason = invalidSourceReason("__new__", body.credentialSourceUserId);
    if (reason) {
      fail(res, 400, "INVALID_CREDENTIAL_SOURCE", reason);
      return;
    }
  }
  // ADMIN_EMAILS is authoritative — a listed email is always an admin.
  const role = isAdminEmail(body.email) ? "admin" : (body.role ?? "user");
  const created = createUser(body.email, hashPassword(body.password), role, {
    ...(body.credentialSourceUserId ? { credentialSourceUserId: body.credentialSourceUserId } : {}),
    ...(body.allowWrites !== undefined ? { allowWrites: body.allowWrites } : {}),
    ...(body.sharedProviders !== undefined ? { sharedProviders: body.sharedProviders } : {}),
  });
  res.status(201).json({ ok: true, data: userView(created) });
});

const updateUserSchema = z.object({
  email: z.string().email().max(200).optional(),
  password: z.string().min(8).max(200).optional(),
  /** null clears the delegation (the user goes back to their own credentials). */
  credentialSourceUserId: z.string().min(1).nullable().optional(),
  allowWrites: z.boolean().optional(),
  disabled: z.boolean().optional(),
  /** v1.67 (ADR-078) — null clears the restriction back to share-all. */
  sharedProviders: z.array(z.enum(["jira", "github", "ai"])).nullable().optional(),
});

// PUT /api/admin/users/:id — update account fields, delegation, write access, disabled state.
adminRouter.put("/api/admin/users/:id", requireAdmin, (req: Request, res: Response) => {
  const target = findUserById(req.params["id"] ?? "");
  if (!target) {
    fail(res, 404, "NOT_FOUND", "User not found");
    return;
  }
  let body;
  try {
    body = updateUserSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "Invalid user update", (err as ZodError).issues);
    return;
  }

  const selfId = res.locals["userId"] as string;
  if (body.disabled === true) {
    if (target.id === selfId) {
      fail(res, 409, "CANNOT_DISABLE_SELF", "You can't disable your own account");
      return;
    }
    if (isAdminEmail(target.email)) {
      fail(res, 409, "BOOTSTRAP_ADMIN", "This account is an admin via ADMIN_EMAILS and can't be disabled here");
      return;
    }
  }
  if (body.email && body.email.trim().toLowerCase() !== target.email) {
    const clash = findUserByEmail(body.email);
    if (clash && clash.id !== target.id) {
      fail(res, 409, "EMAIL_TAKEN", "An account with that email already exists");
      return;
    }
  }
  if (body.credentialSourceUserId) {
    const reason = invalidSourceReason(target.id, body.credentialSourceUserId);
    if (reason) {
      fail(res, 400, "INVALID_CREDENTIAL_SOURCE", reason);
      return;
    }
    // A lender can't become a borrower while others depend on them (no chains).
    if (listUsersByCredentialSource(target.id).length > 0) {
      fail(res, 409, "IN_USE", "Other users borrow this account's credentials, so it can't borrow from someone else");
      return;
    }
  }

  const patch: Parameters<typeof updateUser>[1] = {};
  if (body.email !== undefined) patch.email = body.email;
  if (body.password !== undefined) patch.passwordHash = hashPassword(body.password);
  if (body.credentialSourceUserId !== undefined) patch.credentialSourceUserId = body.credentialSourceUserId;
  if (body.allowWrites !== undefined) patch.allowWrites = body.allowWrites;
  if (body.disabled !== undefined) patch.disabled = body.disabled;
  if (body.sharedProviders !== undefined) patch.sharedProviders = body.sharedProviders;

  const updated = updateUser(target.id, patch);
  res.json({ ok: true, data: userView(updated as StoredUser) });
});

// DELETE /api/admin/users/:id — hard delete (account + encrypted connections + config overrides).
adminRouter.delete("/api/admin/users/:id", requireAdmin, (req: Request, res: Response) => {
  const target = findUserById(req.params["id"] ?? "");
  if (!target) {
    fail(res, 404, "NOT_FOUND", "User not found");
    return;
  }
  const selfId = res.locals["userId"] as string;
  if (target.id === selfId) {
    fail(res, 409, "CANNOT_DELETE_SELF", "You can't delete your own account");
    return;
  }
  if (isAdminEmail(target.email)) {
    fail(res, 409, "BOOTSTRAP_ADMIN", "This account is an admin via ADMIN_EMAILS and can't be deleted here");
    return;
  }
  const dependents = listUsersByCredentialSource(target.id);
  if (dependents.length > 0) {
    fail(
      res,
      409,
      "IN_USE",
      `${dependents.length} user(s) borrow this account's credentials (${dependents.map((d) => d.email).join(", ")}). Reassign them first.`
    );
    return;
  }
  deleteUser(target.id);
  res.json({ ok: true, data: { deleted: true, id: target.id } });
});

// ── Config templates (v1.47, ADR-057) — reusable named config bundles ──────────

const templateSchema = z.object({
  name: z.string().min(1).max(80),
  config: adminConfigSchema,
});

adminRouter.get("/api/admin/templates", requireAdmin, (_req: Request, res: Response) => {
  res.json({ ok: true, data: { templates: listConfigTemplates() } });
});

adminRouter.post("/api/admin/templates", requireAdmin, (req: Request, res: Response) => {
  let body;
  try {
    body = templateSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "A name and a valid config are required", (err as ZodError).issues);
    return;
  }
  if (findConfigTemplateByName(body.name)) {
    fail(res, 409, "NAME_TAKEN", "A template with that name already exists");
    return;
  }
  res.status(201).json({ ok: true, data: createConfigTemplate(body.name, body.config) });
});

adminRouter.put("/api/admin/templates/:id", requireAdmin, (req: Request, res: Response) => {
  const existing = findConfigTemplateById(req.params["id"] ?? "");
  if (!existing) {
    fail(res, 404, "NOT_FOUND", "Template not found");
    return;
  }
  let body;
  try {
    body = templateSchema.partial().parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "Invalid template update", (err as ZodError).issues);
    return;
  }
  if (body.name) {
    const clash = findConfigTemplateByName(body.name);
    if (clash && clash.id !== existing.id) {
      fail(res, 409, "NAME_TAKEN", "A template with that name already exists");
      return;
    }
  }
  res.json({ ok: true, data: updateConfigTemplate(existing.id, body) });
});

adminRouter.delete("/api/admin/templates/:id", requireAdmin, (req: Request, res: Response) => {
  if (!deleteConfigTemplate(req.params["id"] ?? "")) {
    fail(res, 404, "NOT_FOUND", "Template not found");
    return;
  }
  res.json({ ok: true, data: { deleted: true } });
});

/** Apply a template's config. `merge: true` layers it over what's already set; default replaces. */
const applySchema = z.object({ templateId: z.string().min(1), merge: z.boolean().optional() });

adminRouter.post("/api/admin/users/:id/config/apply-template", requireAdmin, (req: Request, res: Response) => {
  const target = findUserById(req.params["id"] ?? "");
  if (!target) {
    fail(res, 404, "NOT_FOUND", "User not found");
    return;
  }
  let body;
  try {
    body = applySchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "templateId is required", (err as ZodError).issues);
    return;
  }
  const tpl = findConfigTemplateById(body.templateId);
  if (!tpl) {
    fail(res, 404, "NOT_FOUND", "Template not found");
    return;
  }
  setUserConfig(target.id, body.merge ? { ...getUserConfig(target.id), ...tpl.config } : tpl.config);
  res.json({ ok: true, data: userView(findUserById(target.id) as StoredUser) });
});

adminRouter.post("/api/admin/config/apply-template", requireAdmin, (req: Request, res: Response) => {
  let body;
  try {
    body = applySchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "templateId is required", (err as ZodError).issues);
    return;
  }
  const tpl = findConfigTemplateById(body.templateId);
  if (!tpl) {
    fail(res, 404, "NOT_FOUND", "Template not found");
    return;
  }
  setGlobalConfig(body.merge ? { ...getGlobalConfig(), ...tpl.config } : tpl.config);
  res.json({ ok: true, data: { globalConfig: getGlobalConfig() } });
});

const roleSchema = z.object({ role: z.enum(["admin", "user"]) });

// PUT /api/admin/users/:id/role — promote/demote. ADMIN_EMAILS accounts can't be demoted here.
adminRouter.put("/api/admin/users/:id/role", requireAdmin, (req: Request, res: Response) => {
  const target = findUserById(req.params["id"] ?? "");
  if (!target) {
    fail(res, 404, "NOT_FOUND", "User not found");
    return;
  }
  let body;
  try {
    body = roleSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "role must be 'admin' or 'user'", (err as ZodError).issues);
    return;
  }
  if (body.role === "user" && isAdminEmail(target.email)) {
    fail(res, 409, "BOOTSTRAP_ADMIN", "This account is an admin via ADMIN_EMAILS and can't be demoted here");
    return;
  }
  setUserRole(target.id, body.role);
  res.json({ ok: true, data: userView(findUserById(target.id) as StoredUser) });
});

// ── Teams (v1.73, ADR-084) ──────────────────────────────────────────────────

const teamSchema = z.object({
  name: z.string().min(1).max(80),
  config: adminConfigSchema.optional(),
});

adminRouter.get("/api/admin/teams", requireAdmin, (_req: Request, res: Response) => {
  res.json({ ok: true, data: { teams: listTeams().map(teamView) } });
});

adminRouter.post("/api/admin/teams", requireAdmin, (req: Request, res: Response) => {
  let body;
  try {
    body = teamSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "A name is required", (err as ZodError).issues);
    return;
  }
  if (findTeamByName(body.name)) {
    fail(res, 409, "NAME_TAKEN", "A team with that name already exists");
    return;
  }
  res.status(201).json({ ok: true, data: teamView(createTeam(body.name, body.config ?? {})) });
});

adminRouter.put("/api/admin/teams/:id", requireAdmin, (req: Request, res: Response) => {
  const existing = findTeamById(req.params["id"] ?? "");
  if (!existing) {
    fail(res, 404, "NOT_FOUND", "Team not found");
    return;
  }
  let body;
  try {
    body = teamSchema.partial().parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "Invalid team update", (err as ZodError).issues);
    return;
  }
  if (body.name) {
    const clash = findTeamByName(body.name);
    if (clash && clash.id !== existing.id) {
      fail(res, 409, "NAME_TAKEN", "A team with that name already exists");
      return;
    }
  }
  res.json({ ok: true, data: teamView(updateTeam(existing.id, body) as Team) });
});

adminRouter.delete("/api/admin/teams/:id", requireAdmin, (req: Request, res: Response) => {
  const existing = findTeamById(req.params["id"] ?? "");
  if (!existing) {
    fail(res, 404, "NOT_FOUND", "Team not found");
    return;
  }
  const members = listUsersByTeam(existing.id);
  if (members.length > 0) {
    fail(
      res,
      409,
      "IN_USE",
      `${members.length} user(s) belong to this team (${members.map((m) => m.email).join(", ")}). Reassign them first.`
    );
    return;
  }
  deleteTeam(existing.id);
  res.json({ ok: true, data: { deleted: true } });
});

const teamAssignSchema = z.object({ teamId: z.string().min(1).nullable() });

// PUT /api/admin/users/:id/team — assign/clear the team a user belongs to (storage SCOPE only).
adminRouter.put("/api/admin/users/:id/team", requireAdmin, (req: Request, res: Response) => {
  const target = findUserById(req.params["id"] ?? "");
  if (!target) {
    fail(res, 404, "NOT_FOUND", "User not found");
    return;
  }
  let body;
  try {
    body = teamAssignSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "teamId is required (string or null)", (err as ZodError).issues);
    return;
  }
  if (body.teamId !== null && !findTeamById(body.teamId)) {
    fail(res, 404, "NOT_FOUND", "Team not found");
    return;
  }
  const updated = updateUser(target.id, { teamId: body.teamId });
  res.json({ ok: true, data: userView(updated as StoredUser) });
});

const adoptSchema = z.object({ fromUserId: z.string().min(1) });

// POST /api/admin/teams/:id/adopt — one-time seeding: copy a user's personal docs into the team's
// shared scope. Non-destructive (see storage/adopt.ts) — never overwrites a doc already at the target.
adminRouter.post("/api/admin/teams/:id/adopt", requireAdmin, (req: Request, res: Response) => {
  const team = findTeamById(req.params["id"] ?? "");
  if (!team) {
    fail(res, 404, "NOT_FOUND", "Team not found");
    return;
  }
  let body;
  try {
    body = adoptSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "fromUserId is required", (err as ZodError).issues);
    return;
  }
  if (!findUserById(body.fromUserId)) {
    fail(res, 404, "NOT_FOUND", "Source user not found");
    return;
  }
  // The source of a user's OWN personal docs is their raw user id — NOT a team scope.
  const result = adoptScopeDocs(body.fromUserId, teamScope(team.id), TEAM_SCOPED_STORE_NAMES);
  res.json({ ok: true, data: result });
});
