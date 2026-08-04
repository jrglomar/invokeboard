/**
 * Task Helper router (v1.44, ADR-054) — auth + per-user connections + AI ticket→prompt.
 * Mounted on the mcp-jira bridge. Imported ONLY here / by http.ts — never by the MCP tool
 * registry or the stdio entry, so the tool set + Copilot's server are unaffected.
 *
 * Phase A: /api/auth/* (signup, login, logout, me). Connections (§8.4) and tasks (§8.5) are
 * added in later phases onto this same router.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { z, ZodError } from "zod";
import { isTaskHelperConfigured, isAdminEmail } from "../lib/config.js";
import { hashPassword, verifyPassword } from "../lib/auth/password.js";
import { issueSession, SESSION_COOKIE } from "../lib/auth/session.js";
import { requireAuth } from "../lib/auth/middleware.js";
import { isAdmin } from "../lib/auth/adminMiddleware.js";
import {
  createUser, findUserByEmail, findUserById, updateUser,
  upsertConnection, deleteConnection, findTeamById,
} from "../lib/userStore.js";
import { seal, open, maskHint } from "../lib/crypto/secretBox.js";
import { validateJira, fetchMySprintIssues, fetchIssueDetail, type JiraCreds } from "../lib/userJira.js";
import { validateGithub } from "../lib/userGithub.js";
import { validateAi, type AiProviderName } from "../lib/userAi.js";
import { getAiProvider, getAiStatus } from "../lib/ai/provider.js";
import { runTaskHelper } from "../lib/ai/taskHelperService.js";
import { resolveUser } from "../lib/userConfig.js";
import { runWithUser } from "../lib/requestContext.js";
import { getProjects, getOffsetPolicy, getAgingPolicy } from "../lib/config.js";
import { getEffectiveConnection } from "../lib/delegation.js";
import {
  getSprintJournal, addNote, deleteNote, addTodo, updateTodo, deleteTodo,
} from "../lib/journalStore.js";

export const taskHelperRouter = express.Router();

// ── Envelope helpers (match the bridge's { ok, error } shape) ──────────────────

function fail(res: Response, status: number, code: string, message: string, issues?: unknown[]): void {
  const body: { ok: false; error: { code: string; message: string; issues?: unknown[] } } = {
    ok: false,
    error: { code, message },
  };
  if (issues !== undefined) body.error.issues = issues;
  res.status(status).json(body);
}

// ── Cookie options ─────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env["NODE_ENV"] === "production", // http on localhost/LAN in dev
    path: "/",
    maxAge: SESSION_TTL_MS,
  };
}

// ── Enablement guard: Task Helper paths 503 unless both secrets are set ─────────
// Scoped to /api/auth + /api/me ONLY (the router is mounted at root, so a blanket guard
// would wrongly intercept /api/tools, /api/health, /api/ai/* too).

taskHelperRouter.use(["/api/auth", "/api/me"], (_req: Request, res: Response, next: NextFunction) => {
  if (!isTaskHelperConfigured()) {
    fail(
      res,
      503,
      "TASK_HELPER_UNAVAILABLE",
      "Task Helper is disabled — set TOKEN_ENC_KEY and SESSION_SECRET (see docs/SETUP.md)"
    );
    return;
  }
  next();
});

// ── Basic in-memory login rate limiting (per email) ─────────────────────────────

const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX_FAILS = 10;
const loginFails = new Map<string, { count: number; first: number }>();

function tooManyFails(email: string): boolean {
  const rec = loginFails.get(email);
  if (!rec) return false;
  if (Date.now() - rec.first > RL_WINDOW_MS) {
    loginFails.delete(email);
    return false;
  }
  return rec.count >= RL_MAX_FAILS;
}
function recordFail(email: string): void {
  const rec = loginFails.get(email);
  if (!rec || Date.now() - rec.first > RL_WINDOW_MS) {
    loginFails.set(email, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

// ── Schemas ─────────────────────────────────────────────────────────────────────

const credsSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
});

// ── Auth routes ─────────────────────────────────────────────────────────────────

taskHelperRouter.post("/api/auth/signup", (req: Request, res: Response) => {
  let creds;
  try {
    creds = credsSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "Email and an 8+ char password are required", (err as ZodError).issues);
    return;
  }
  if (findUserByEmail(creds.email)) {
    fail(res, 409, "EMAIL_TAKEN", "An account with that email already exists");
    return;
  }
  // v1.45 (ADR-055): ADMIN_EMAILS bootstraps the super-admin role at signup.
  const role = isAdminEmail(creds.email) ? "admin" : "user";
  const user = createUser(creds.email, hashPassword(creds.password), role);
  res.cookie(SESSION_COOKIE, issueSession(user.id), sessionCookieOptions());
  res.json({ ok: true, data: { email: user.email, role } });
});

taskHelperRouter.post("/api/auth/login", (req: Request, res: Response) => {
  let creds;
  try {
    creds = credsSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "Email and password are required", (err as ZodError).issues);
    return;
  }
  const email = creds.email.trim().toLowerCase();
  if (tooManyFails(email)) {
    fail(res, 429, "RATE_LIMITED", "Too many attempts — try again later");
    return;
  }
  const user = findUserByEmail(email);
  if (!user || !verifyPassword(creds.password, user.passwordHash)) {
    recordFail(email);
    fail(res, 401, "BAD_CREDENTIALS", "Invalid email or password");
    return;
  }
  if (user.disabled) {
    // v1.46 (ADR-056) — disabled accounts can't sign in.
    fail(res, 403, "ACCOUNT_DISABLED", "This account has been disabled — contact an admin");
    return;
  }
  loginFails.delete(email);
  res.cookie(SESSION_COOKIE, issueSession(user.id), sessionCookieOptions());
  res.json({ ok: true, data: { email: user.email, role: isAdmin(user) ? "admin" : "user" } });
});

taskHelperRouter.post("/api/auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true, data: { loggedOut: true } });
});

taskHelperRouter.get("/api/auth/me", requireAuth, (_req: Request, res: Response) => {
  const user = findUserById(res.locals["userId"] as string);
  if (!user) {
    fail(res, 401, "UNAUTHENTICATED", "Sign in to use the Task Helper");
    return;
  }
  res.json({ ok: true, data: { email: user.email, role: isAdmin(user) ? "admin" : "user" } });
});

// v1.67 (ADR-078) — self-service password change, any signed-in role (user or admin). Distinct
// from the admin's "reset a user's password" (PUT /api/admin/users/:id) — this one requires proving
// the CURRENT password first, since it's the account holder acting on themselves.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

taskHelperRouter.put("/api/auth/password", requireAuth, (req: Request, res: Response) => {
  let body;
  try {
    body = changePasswordSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "currentPassword and an 8+ char newPassword are required", (err as ZodError).issues);
    return;
  }
  const user = findUserById(res.locals["userId"] as string);
  if (!user) {
    fail(res, 401, "UNAUTHENTICATED", "Sign in to use the Task Helper");
    return;
  }
  if (!verifyPassword(body.currentPassword, user.passwordHash)) {
    fail(res, 401, "INVALID_PASSWORD", "Current password is incorrect");
    return;
  }
  updateUser(user.id, { passwordHash: hashPassword(body.newPassword) });
  res.json({ ok: true, data: { changed: true } });
});

// ── Connections (§8.4) — tokens are validated, encrypted, and NEVER returned raw ────

const uid = (res: Response): string => res.locals["userId"] as string;

/** Email of a user id, for labelling a borrowed connection. */
function emailOf(userId: string | null): string {
  if (!userId) return "";
  return findUserById(userId)?.email ?? "";
}

/**
 * Masked, safe-to-surface connection status for the current user (tokens NEVER included).
 * v1.46 (ADR-056): resolves EFFECTIVE connections — a shared-credential user sees the connection
 * they borrow, flagged `inherited` with the owner's email. The owner's masked token hint is NOT
 * exposed to a borrower.
 */
function connectionStatus(userId: string) {
  const jira = getEffectiveConnection(userId, "jira");
  const github = getEffectiveConnection(userId, "github");
  const ai = getEffectiveConnection(userId, "ai");
  return {
    jira: jira
      ? {
          connected: true,
          baseUrl: jira.conn.meta["baseUrl"] ?? "",
          email: jira.conn.meta["email"] ?? "",
          hint: jira.viaUserId ? "" : (jira.conn.meta["hint"] ?? ""),
          inherited: jira.viaUserId !== null,
          via: emailOf(jira.viaUserId),
        }
      : null,
    github: github
      ? {
          connected: true,
          login: github.conn.meta["login"] ?? "",
          hint: github.viaUserId ? "" : (github.conn.meta["hint"] ?? ""),
          inherited: github.viaUserId !== null,
          via: emailOf(github.viaUserId),
        }
      : null,
    ai: ai
      ? {
          connected: true,
          provider: ai.conn.meta["provider"] ?? "",
          model: ai.conn.meta["model"] ?? "",
          hint: ai.viaUserId ? "" : (ai.conn.meta["hint"] ?? ""),
          inherited: ai.viaUserId !== null,
          via: emailOf(ai.viaUserId),
        }
      : null,
  };
}

const jiraConnSchema = z.object({
  baseUrl: z.string().url().max(300),
  email: z.string().email().max(200),
  token: z.string().min(1).max(500),
});
const githubConnSchema = z.object({ token: z.string().min(1).max(500) });

taskHelperRouter.get("/api/me/connections", requireAuth, (_req: Request, res: Response) => {
  res.json({ ok: true, data: connectionStatus(uid(res)) });
});

taskHelperRouter.put("/api/me/connections/jira", requireAuth, async (req: Request, res: Response) => {
  let body;
  try {
    body = jiraConnSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "baseUrl, email and token are required", (err as ZodError).issues);
    return;
  }
  let identity;
  try {
    identity = await validateJira(body);
  } catch (err) {
    fail(res, 400, "INVALID_CONNECTION", err instanceof Error ? err.message : "Could not validate Jira");
    return;
  }
  upsertConnection(uid(res), "jira", {
    enc: seal(body.token),
    meta: {
      baseUrl: body.baseUrl.replace(/\/+$/, ""),
      email: body.email,
      hint: maskHint(body.token),
      accountId: identity.accountId,
      displayName: identity.displayName,
    },
    updatedAt: new Date().toISOString(),
  });
  res.json({ ok: true, data: connectionStatus(uid(res)) });
});

taskHelperRouter.put("/api/me/connections/github", requireAuth, async (req: Request, res: Response) => {
  let body;
  try {
    body = githubConnSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "A GitHub token is required", (err as ZodError).issues);
    return;
  }
  let identity;
  try {
    identity = await validateGithub(body.token);
  } catch (err) {
    fail(res, 400, "INVALID_CONNECTION", err instanceof Error ? err.message : "Could not validate GitHub");
    return;
  }
  upsertConnection(uid(res), "github", {
    enc: seal(body.token),
    meta: { login: identity.login, hint: maskHint(body.token) },
    updatedAt: new Date().toISOString(),
  });
  res.json({ ok: true, data: connectionStatus(uid(res)) });
});

const aiConnSchema = z.object({
  provider: z.enum(["anthropic", "github"]),
  token: z.string().min(1).max(500),
  model: z.string().max(100).optional(),
});

taskHelperRouter.put("/api/me/connections/ai", requireAuth, async (req: Request, res: Response) => {
  let body;
  try {
    body = aiConnSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "provider (anthropic|github) and token are required", (err as ZodError).issues);
    return;
  }
  let validated;
  try {
    validated = await validateAi(body.provider as AiProviderName, body.token, body.model);
  } catch (err) {
    fail(res, 400, "INVALID_CONNECTION", err instanceof Error ? err.message : "Could not validate the AI token");
    return;
  }
  upsertConnection(uid(res), "ai", {
    enc: seal(body.token),
    meta: { provider: validated.provider, model: validated.model, hint: maskHint(body.token) },
    updatedAt: new Date().toISOString(),
  });
  res.json({ ok: true, data: connectionStatus(uid(res)) });
});

taskHelperRouter.delete("/api/me/connections/:provider", requireAuth, (req: Request, res: Response) => {
  const provider = req.params["provider"];
  if (provider !== "jira" && provider !== "github" && provider !== "ai") {
    fail(res, 400, "VALIDATION", "Unknown provider");
    return;
  }
  deleteConnection(uid(res), provider);
  res.json({ ok: true, data: connectionStatus(uid(res)) });
});

// ── Context (§9) — connection status + boards + readiness for the app-wide gate ─────
taskHelperRouter.get("/api/me/context", requireAuth, (_req: Request, res: Response) => {
  const userId = uid(res);
  const user = findUserById(userId);
  const status = connectionStatus(userId);
  // Gate needs Jira + GitHub — OWN or inherited from a credential source (ADR-056).
  const ready = !!status.jira && !!status.github;
  // Boards + offset policy + AI status resolve from the user's EFFECTIVE config (their Jira + global/
  // admin/inherited/per-user overrides). v1.51 (ADR-062): the UI reads boards/policy from here — NOT the
  // global, unauthenticated GET /api/health. v1.53 (ADR-064): the AI status too, so a user on their OWN
  // AI token (with no global .env AI) sees the assistant/drafting enabled instead of "AI disabled".
  // v1.58 (ADR-070): the ticket-aging policy resolves the same per-user way.
  let boards: { dev: unknown[]; po: unknown[] } = { dev: [], po: [] };
  let policy = getOffsetPolicy(); // global default when the user isn't resolvable yet
  let aging = getAgingPolicy(); // ditto — global .env aging policy until we can resolve the user
  let ai = getAiStatus(); // ditto — global .env AI status until we can resolve the user
  const resolved = resolveUser(userId);
  if (resolved) {
    ({ boards, policy, aging, ai } = runWithUser(
      { userId, config: resolved.config, storeUserId: resolved.storeUserId, canWriteJira: resolved.canWriteJira },
      () => ({ boards: getProjects(), policy: getOffsetPolicy(), aging: getAgingPolicy(), ai: getAiStatus() })
    ));
  }
  const role = user && isAdmin(user) ? "admin" : "user";
  // v1.46: the UI shows a "read-only (shared credentials)" banner and hides Jira-write affordances.
  const readOnly = resolved ? !resolved.canWriteJira : false;
  const sharedFrom = resolved?.sharedFromUserId ? emailOf(resolved.sharedFromUserId) : null;
  // v1.73 (ADR-084) — the team the user belongs to (if any), so the UI can show/gate team-scoped features.
  const teamRef = user?.teamId ? findTeamById(user.teamId) : null;
  const team = teamRef ? { id: teamRef.id, name: teamRef.name } : null;
  res.json({ ok: true, data: { connections: status, ready, boards, policy, aging, ai, role, readOnly, sharedFrom, team } });
});

// ── Tasks (§8.5) — fetch my tickets + AI refine→prompt ───────────────────────

/**
 * Decrypt the user's EFFECTIVE Jira connection into live creds, or null if none.
 * v1.46 (ADR-056): falls back to the credential source's connection for shared-credential users.
 */
function userJiraCreds(userId: string): JiraCreds | null {
  const eff = getEffectiveConnection(userId, "jira");
  if (!eff) return null;
  const { meta, enc } = eff.conn;
  return { baseUrl: meta["baseUrl"] ?? "", email: meta["email"] ?? "", token: open(enc) };
}

/** v1.46 (ADR-055 Phase F): optional `?sprintId=` scopes the fetch to the board's selected sprint. */
const issuesQuerySchema = z.object({
  sprintId: z.coerce.number().int().positive().optional(),
});

taskHelperRouter.get("/api/me/tasks/issues", requireAuth, async (req: Request, res: Response) => {
  let query;
  try {
    query = issuesQuerySchema.parse(req.query);
  } catch (err) {
    fail(res, 400, "VALIDATION", "sprintId must be a positive integer", (err as ZodError).issues);
    return;
  }
  const creds = userJiraCreds(uid(res));
  if (!creds) {
    fail(res, 409, "NO_JIRA_CONNECTION", "Connect your Jira account first");
    return;
  }
  try {
    res.json({ ok: true, data: { issues: await fetchMySprintIssues(creds, query.sprintId) } });
  } catch (err) {
    fail(res, 502, "UPSTREAM", err instanceof Error ? err.message : "Could not fetch your issues");
  }
});

// ── Personal sprint journal (§8.6, v1.47/v1.48 — ADR-057/058) ─────────────────
//
// Notes are a quick-add feed of timestamped entries; to-dos are a sprint checklist.
// Keyed by the user's REAL id, so a shared-credential user keeps their OWN journal rather than
// writing into the token owner's (ADR-056).

const TICKET_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

const journalQuerySchema = z.object({ sprintId: z.coerce.number().int().positive() });

const newNoteSchema = z.object({
  sprintId: z.number().int().positive(),
  text: z.string().min(1).max(5000),
});

const newTodoSchema = z.object({
  sprintId: z.number().int().positive(),
  text: z.string().min(1).max(500),
  ticketKey: z.string().regex(TICKET_RE).optional(),
});

const patchTodoSchema = z.object({
  text: z.string().min(1).max(500).optional(),
  done: z.boolean().optional(),
  ticketKey: z.string().regex(TICKET_RE).nullable().optional(),
});

taskHelperRouter.get("/api/me/journal", requireAuth, (req: Request, res: Response) => {
  let query;
  try {
    query = journalQuerySchema.parse(req.query);
  } catch (err) {
    fail(res, 400, "VALIDATION", "A positive sprintId is required", (err as ZodError).issues);
    return;
  }
  res.json({ ok: true, data: getSprintJournal(uid(res), query.sprintId) });
});

taskHelperRouter.post("/api/me/journal/notes", requireAuth, (req: Request, res: Response) => {
  let body;
  try {
    body = newNoteSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "sprintId and a non-empty text are required", (err as ZodError).issues);
    return;
  }
  res.status(201).json({ ok: true, data: addNote(uid(res), body) });
});

taskHelperRouter.delete("/api/me/journal/notes/:id", requireAuth, (req: Request, res: Response) => {
  if (!deleteNote(uid(res), req.params["id"] ?? "")) {
    fail(res, 404, "NOT_FOUND", "Note not found");
    return;
  }
  res.json({ ok: true, data: { deleted: true } });
});

taskHelperRouter.post("/api/me/journal/todos", requireAuth, (req: Request, res: Response) => {
  let body;
  try {
    body = newTodoSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "sprintId and a non-empty text are required", (err as ZodError).issues);
    return;
  }
  res.status(201).json({ ok: true, data: addTodo(uid(res), body) });
});

taskHelperRouter.patch("/api/me/journal/todos/:id", requireAuth, (req: Request, res: Response) => {
  let body;
  try {
    body = patchTodoSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "Invalid to-do update", (err as ZodError).issues);
    return;
  }
  const updated = updateTodo(uid(res), req.params["id"] ?? "", body);
  if (!updated) {
    fail(res, 404, "NOT_FOUND", "To-do not found");
    return;
  }
  res.json({ ok: true, data: updated });
});

taskHelperRouter.delete("/api/me/journal/todos/:id", requireAuth, (req: Request, res: Response) => {
  if (!deleteTodo(uid(res), req.params["id"] ?? "")) {
    fail(res, 404, "NOT_FOUND", "To-do not found");
    return;
  }
  res.json({ ok: true, data: { deleted: true } });
});

// ── AI refine → prompt ────────────────────────────────────────────────────────

const helpSchema = z.object({
  ticketKey: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/, "ticketKey must look like PROJECT-123"),
  extraContext: z.string().max(4000).optional(),
});

taskHelperRouter.post("/api/me/tasks/help", requireAuth, async (req: Request, res: Response) => {
  let body;
  try {
    body = helpSchema.parse(req.body);
  } catch (err) {
    fail(res, 400, "VALIDATION", "A valid ticketKey is required", (err as ZodError).issues);
    return;
  }
  const userId = uid(res);
  const resolved = resolveUser(userId);
  if (!resolved) {
    fail(res, 409, "NO_JIRA_CONNECTION", "Connect your Jira account first");
    return;
  }
  const cfg = resolved.config;
  const creds: JiraCreds = { baseUrl: cfg.JIRA_BASE_URL, email: cfg.JIRA_EMAIL, token: cfg.JIRA_API_TOKEN };
  try {
    // Run the AI in the user's context so getAiProvider() uses THEIR own (or inherited) AI token.
    const outcome = await runWithUser(
      { userId, config: cfg, storeUserId: resolved.storeUserId, canWriteJira: resolved.canWriteJira },
      async () => {
        const provider = await getAiProvider();
        if (provider === null) return { kind: "no-ai" as const };
        const detail = await fetchIssueDetail(creds, body.ticketKey);
        const result = await runTaskHelper(provider, {
          key: detail.key,
          summary: detail.summary,
          description: detail.description,
          issueType: detail.issueType,
          extraContext: body.extraContext,
        });
        return { kind: "ok" as const, result };
      }
    );
    if (outcome.kind === "no-ai") {
      fail(res, 503, "AI_UNAVAILABLE", "Connect your AI token (or set AI_PROVIDER + key) to use the Task Helper");
      return;
    }
    res.json({ ok: true, data: outcome.result });
  } catch (err) {
    fail(res, 502, "UPSTREAM", err instanceof Error ? err.message : "Task Helper failed");
  }
});
