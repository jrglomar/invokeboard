import { z } from "zod";
import { ConfigError } from "./errors.js";
import { getRequestConfig, getRequestStoreUserId } from "./requestContext.js";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

// Compute the mcp-jira package directory at module load time (ESM-safe).
// src/lib/config.ts → ../../  = packages/mcp-jira/
const _thisDir = path.dirname(fileURLToPath(import.meta.url));
const _packageDir = path.resolve(_thisDir, "../..");

/**
 * Per-user store root (v1.45, ADR-055). When a request runs in a user context, the local
 * JSON stores live under `<usersDir>/<userId>/…` so board-id keys can't collide across users.
 */
export const USER_STORES_DIR = path.join(_packageDir, ".invokeboard-user-stores");

/**
 * Resolve a store file path. In a per-user request context → that user's directory; otherwise the
 * override (env) or the shared default (back-compat / stdio / tests).
 *
 * v1.46 (ADR-056): the id is the STORE user — a user on shared credentials resolves to the
 * credential owner's directory, so they see the same team leaves/retro/notes/offset.
 */
function resolveStorePath(perUserBasename: string, override: string, sharedDefault: string): string {
  const uid = getRequestStoreUserId();
  if (uid) return path.join(USER_STORES_DIR, uid, perUserBasename);
  return override || sharedDefault;
}

/** Default path for the leaves JSON file — inside the mcp-jira package dir. */
export const DEFAULT_LEAVES_FILE = path.join(_packageDir, ".invokeboard-leaves.json");

/** Default path for the team roster JSON file — inside the mcp-jira package dir. */
export const DEFAULT_TEAM_FILE = path.join(_packageDir, ".invokeboard-team.json");

/** Default path for the impediments JSON file — inside the mcp-jira package dir (v1.16). */
export const DEFAULT_IMPEDIMENTS_FILE = path.join(_packageDir, ".invokeboard-impediments.json");

/** Default path for the pull-requests JSON file — inside the mcp-jira package dir (v1.16). */
export const DEFAULT_PRS_FILE = path.join(_packageDir, ".invokeboard-prs.json");

/** Default path for the post-scrum notes JSON file — inside the mcp-jira package dir (v1.20). */
export const DEFAULT_POST_SCRUM_FILE = path.join(_packageDir, ".invokeboard-post-scrum.json");

/** Default path for the meeting-goal JSON file — inside the mcp-jira package dir (v1.20). */
export const DEFAULT_MEETING_GOAL_FILE = path.join(_packageDir, ".invokeboard-meeting-goal.json");

/** Default path for the meeting-notes JSON file — inside the mcp-jira package dir (v1.41). */
export const DEFAULT_MEETING_NOTES_FILE = path.join(_packageDir, ".invokeboard-meeting-notes.json");

/** Default path for the retro JSON file — inside the mcp-jira package dir (v1.42). */
export const DEFAULT_RETRO_FILE = path.join(_packageDir, ".invokeboard-retro.json");

/** Default path for the offset-ledger JSON file — inside the mcp-jira package dir (v1.26). */
export const DEFAULT_OFFSET_FILE = path.join(_packageDir, ".invokeboard-offset.json");

/** Default path for the Task Helper user store (v1.44) — users + encrypted connections. */
export const DEFAULT_TASK_HELPER_FILE = path.join(_packageDir, ".invokeboard-users.json");

/** Default path for the PO draft-capacity-plan JSON file — inside the mcp-jira package dir (v1.68). */
export const DEFAULT_DRAFT_PLAN_FILE = path.join(_packageDir, ".invokeboard-draft-plan.json");

// Config schema — validated lazily on first call to getConfig().
// All env reads happen inside getConfig(), never at module-import time,
// so tool modules can be imported in tests without a .env file.
const configSchema = z.object({
  JIRA_BASE_URL: z.string().min(1),
  JIRA_EMAIL: z.string().min(1),
  JIRA_API_TOKEN: z.string().min(1),
  JIRA_PO_PROJECT_KEY: z.string().default("PO"),
  JIRA_DEV_PROJECT_KEY: z.string().default("DEV"),
  JIRA_PO_BOARD_ID: z.string().min(1),
  JIRA_DEV_BOARD_ID: z.string().min(1),
  // v1.25 (ADR-037): optional multi-project lists, "KEY:boardId,KEY2:boardId2".
  // Empty → the single PO/Dev project (key + board id above) is the only project for that side.
  JIRA_PO_PROJECTS: z.string().default(""),
  JIRA_DEV_PROJECTS: z.string().default(""),
  JIRA_STORY_POINTS_FIELD: z.string().default("customfield_10016"),
  JIRA_LINK_TYPE: z.string().default("Depends on"), // v1.42 (ADR-046): PO story "depends on" its Dev task(s); exact link-type name
  JIRA_FLAGGED_FIELD: z.string().default(""),
  JIRA_CODE_REVIEW_STATUSES: z
    .string()
    .default("code review,in review,peer review,review"),
  JIRA_VELOCITY_SPRINTS: z.coerce.number().int().positive().default(6),
  // v1.26 (ADR-038): offset policy — N required points/sprint + N2 surplus threshold.
  JIRA_REQUIRED_POINTS: z.coerce.number().int().nonnegative().default(8),
  JIRA_OFFSET_THRESHOLD: z.coerce.number().int().positive().default(2),
  // v1.58 (ADR-070) — ticket-aging expectation: expected days in a status =
  // base + perPoint × storyPoints (unpointed issues use the base only).
  JIRA_AGING_BASE_DAYS: z.coerce.number().int().nonnegative().default(1),
  JIRA_AGING_DAYS_PER_POINT: z.coerce.number().int().nonnegative().default(1),
  // v1.26: optional offset-ledger store path; default resolved from package dir.
  JIRA_OFFSET_FILE: z.string().default(""),
  // v1.5: optional leaves file path; default resolved from package dir above.
  JIRA_LEAVES_FILE: z.string().default(""),
  // v1.8: optional team roster file path; default resolved from package dir above.
  JIRA_TEAM_FILE: z.string().default(""),
  // v1.68 (ADR-079): optional PO draft-capacity-plan store path; default resolved above.
  JIRA_DRAFT_PLAN_FILE: z.string().default(""),
  // v1.16: optional impediments + pull-requests store paths (Huddle daily visibility).
  JIRA_IMPEDIMENTS_FILE: z.string().default(""),
  JIRA_PRS_FILE: z.string().default(""),
  // v1.20: optional post-scrum + meeting-goal store paths (Huddle daily sections).
  JIRA_POST_SCRUM_FILE: z.string().default(""),
  JIRA_MEETING_GOAL_FILE: z.string().default(""),
  // v1.41: optional meeting-notes store path (Huddle rich notes, ADR-051).
  JIRA_MEETING_NOTES_FILE: z.string().default(""),
  // v1.42: optional retro store path (persisted retrospective, ADR-052).
  JIRA_RETRO_FILE: z.string().default(""),
  // v1.44 (ADR-054): Task Helper — per-user accounts + encrypted Jira/GitHub connections.
  // All optional; the Task Helper is DISABLED (clear 503) unless BOTH secrets are set.
  TOKEN_ENC_KEY: z.string().default(""), // base64 32 bytes — AES-256-GCM key for tokens at rest
  SESSION_SECRET: z.string().default(""), // HMAC key for signing session cookies
  TASK_HELPER_FILE: z.string().default(""), // user store path; default resolved from package dir
  // v1.45 (ADR-055): comma-separated emails that get the "admin" role on signup (super-admin).
  ADMIN_EMAILS: z.string().default(""),
  // v1.65 (ADR-077): pluggable storage — "json" (dev default, byte-identical per-file stores)
  // or "sqlite" (production, one better-sqlite3 database file). See src/lib/storage/.
  // v1.74 (ADR-085): or "mysql" — the same docs table in MySQL (write-behind cache, mysqlDriver.ts).
  STORAGE_DRIVER: z.enum(["json", "sqlite", "mysql"]).default("json"),
  // Resolved relative to the package dir (same base as the other store defaults) unless absolute.
  STORAGE_SQLITE_FILE: z.string().default(".invokeboard-stores.sqlite"),
  // v1.74: mysql://user:pass@host:3306/db — required iff STORAGE_DRIVER=mysql (checked in getConfig).
  STORAGE_MYSQL_URL: z.string().default(""),
  // v1.22: dev-status applicationType for linked-PR reads (GitHub | GitHubEnterprise | bitbucket).
  JIRA_DEV_STATUS_APP_TYPE: z.string().default("GitHub"),
  MCP_JIRA_HTTP_PORT: z.coerce.number().default(4001),
  // AI drafting — all optional; startup does NOT fail when these are absent.
  AI_PROVIDER: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),
  GITHUB_MODELS_TOKEN: z.string().default(""),
  GITHUB_MODELS_MODEL: z.string().default("openai/gpt-4o-mini"),
  GITHUB_MODELS_BASE_URL: z.string().default("https://models.github.ai/inference"),
});

export type Config = z.infer<typeof configSchema>;

let cachedConfig: Config | null = null;

/**
 * Load dotenv files (package-local wins, repo-root fills the gaps),
 * validate with zod, and cache the result.
 * Throws ConfigError if any required variable is absent.
 * Safe to call multiple times — re-uses the cached result.
 */
export function getConfig(): Config {
  // v1.45 (ADR-055): a per-user request context (AsyncLocalStorage) wins over the global
  // config, so every tool/jiraClient/AI call runs on that user's Jira/GitHub/AI. No context
  // (stdio/Copilot, keyless tests) → the global `.env` config below, exactly as before.
  const reqCfg = getRequestConfig();
  if (reqCfg) return reqCfg;

  if (cachedConfig !== null) return cachedConfig;

  loadDotenv();

  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .filter((i) => i.code === "invalid_type" && i.received === "undefined")
      .map((i) => i.path.join("."));
    // Fall back to listing all errored fields if none were "missing"
    const fields =
      missing.length > 0
        ? missing
        : result.error.issues.map((i) => i.path.join("."));
    throw new ConfigError(fields);
  }

  // v1.74 (ADR-085): the mysql driver has no usable default connection — fail fast, like a missing
  // required var, rather than at the first store access.
  if (result.data.STORAGE_DRIVER === "mysql" && result.data.STORAGE_MYSQL_URL.trim() === "") {
    throw new ConfigError(["STORAGE_MYSQL_URL"]);
  }

  cachedConfig = result.data;
  return cachedConfig;
}

/**
 * Clear the cached config — used in tests to reset state between test cases
 * after manipulating process.env.
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}

/**
 * Return the resolved leaves file path.
 * Reads from config at call time (not import time) so tests can override
 * JIRA_LEAVES_FILE before this is called.
 * Falls back to DEFAULT_LEAVES_FILE when JIRA_LEAVES_FILE is unset/empty.
 */
export function getLeavesFilePath(): string {
  const cfg = getConfig();
  return resolveStorePath("leaves.json", cfg.JIRA_LEAVES_FILE, DEFAULT_LEAVES_FILE);
}

/**
 * Return the resolved team file path.
 * Reads from config at call time (not import time) so tests can override
 * JIRA_TEAM_FILE before this is called.
 * Falls back to DEFAULT_TEAM_FILE when JIRA_TEAM_FILE is unset/empty.
 */
export function getTeamFilePath(): string {
  const cfg = getConfig();
  return resolveStorePath("team.json", cfg.JIRA_TEAM_FILE, DEFAULT_TEAM_FILE);
}

/** Resolved impediments file path (v1.16) — JIRA_IMPEDIMENTS_FILE or the default. */
export function getImpedimentsFilePath(): string {
  const cfg = getConfig();
  return resolveStorePath("impediments.json", cfg.JIRA_IMPEDIMENTS_FILE, DEFAULT_IMPEDIMENTS_FILE);
}

/** Resolved pull-requests file path (v1.16) — JIRA_PRS_FILE or the default. */
export function getPrsFilePath(): string {
  const cfg = getConfig();
  return resolveStorePath("prs.json", cfg.JIRA_PRS_FILE, DEFAULT_PRS_FILE);
}

/** Resolved post-scrum file path (v1.20) — JIRA_POST_SCRUM_FILE or the default. */
export function getPostScrumFilePath(): string {
  const cfg = getConfig();
  return resolveStorePath("post-scrum.json", cfg.JIRA_POST_SCRUM_FILE, DEFAULT_POST_SCRUM_FILE);
}

/** Resolved meeting-goal file path (v1.20) — JIRA_MEETING_GOAL_FILE or the default. */
export function getMeetingGoalFilePath(): string {
  const cfg = getConfig();
  return resolveStorePath("meeting-goal.json", cfg.JIRA_MEETING_GOAL_FILE, DEFAULT_MEETING_GOAL_FILE);
}

/** Resolved meeting-notes file path (v1.41, ADR-051) — JIRA_MEETING_NOTES_FILE or the default. */
export function getMeetingNotesFilePath(): string {
  const cfg = getConfig();
  return resolveStorePath("meeting-notes.json", cfg.JIRA_MEETING_NOTES_FILE, DEFAULT_MEETING_NOTES_FILE);
}

/** Resolved retro file path (v1.42, ADR-052) — JIRA_RETRO_FILE or the default. */
export function getRetroFilePath(): string {
  const cfg = getConfig();
  return resolveStorePath("retro.json", cfg.JIRA_RETRO_FILE, DEFAULT_RETRO_FILE);
}

/** Resolved offset-ledger file path (v1.26) — JIRA_OFFSET_FILE or the default. */
export function getOffsetFilePath(): string {
  const cfg = getConfig();
  return resolveStorePath("offset.json", cfg.JIRA_OFFSET_FILE, DEFAULT_OFFSET_FILE);
}

/** Resolved Task Helper user-store path (v1.44) — TASK_HELPER_FILE or the default. */
export function getTaskHelperFilePath(): string {
  const cfg = getConfig();
  return cfg.TASK_HELPER_FILE || DEFAULT_TASK_HELPER_FILE;
}

/**
 * Return the resolved draft-plan file path.
 * Reads from config at call time (not import time) so tests can override
 * JIRA_DRAFT_PLAN_FILE before this is called.
 * Falls back to DEFAULT_DRAFT_PLAN_FILE when JIRA_DRAFT_PLAN_FILE is unset/empty.
 */
export function getDraftPlanFilePath(): string {
  const cfg = getConfig();
  return resolveStorePath("draft-plan.json", cfg.JIRA_DRAFT_PLAN_FILE, DEFAULT_DRAFT_PLAN_FILE);
}

/**
 * Resolved sqlite database file path (v1.65, ADR-077) — used only when STORAGE_DRIVER=sqlite.
 * STORAGE_SQLITE_FILE resolves relative to the package dir (same base as every other store
 * default) unless it is already absolute (e.g. Docker's `/data/...`).
 */
export function getStorageSqliteFilePath(): string {
  const cfg = getConfig();
  return path.resolve(_packageDir, cfg.STORAGE_SQLITE_FILE);
}

/**
 * Task Helper secrets (v1.44, ADR-054). Returns the raw enc key + session secret.
 * The feature is only enabled when BOTH are present; callers use `isTaskHelperConfigured`.
 */
export function getTaskHelperSecrets(): { encKey: string; sessionSecret: string } {
  const cfg = getConfig();
  return { encKey: cfg.TOKEN_ENC_KEY.trim(), sessionSecret: cfg.SESSION_SECRET.trim() };
}

/** True when BOTH Task Helper secrets are configured (else the feature returns 503). */
export function isTaskHelperConfigured(): boolean {
  const { encKey, sessionSecret } = getTaskHelperSecrets();
  return encKey !== "" && sessionSecret !== "";
}

/**
 * v1.45 (ADR-055) — is this email bootstrapped to the "admin" role via ADMIN_EMAILS?
 * ADMIN_EMAILS is a comma-separated allowlist; matching is case-insensitive. This is the
 * super-admin bootstrap and is AUTHORITATIVE (an ADMIN_EMAILS account is always admin).
 */
export function isAdminEmail(email: string): boolean {
  const list = getConfig()
    .ADMIN_EMAILS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

/** Offset policy (v1.26, ADR-038) — N required points + N2 surplus threshold. */
export function getOffsetPolicy(): { requiredPoints: number; offsetThreshold: number } {
  const cfg = getConfig();
  return { requiredPoints: cfg.JIRA_REQUIRED_POINTS, offsetThreshold: cfg.JIRA_OFFSET_THRESHOLD };
}

/**
 * Ticket-aging policy (v1.58, ADR-070) — how long a ticket is EXPECTED to sit in a status,
 * scaled by its story points: expected = baseDays + daysPerPoint × points (unpointed → base).
 * A sibling of the offset policy, not folded into it (distinct domain; ADR-062/064 pattern).
 */
export function getAgingPolicy(): { baseDays: number; daysPerPoint: number } {
  const cfg = getConfig();
  return { baseDays: cfg.JIRA_AGING_BASE_DAYS, daysPerPoint: cfg.JIRA_AGING_DAYS_PER_POINT };
}

/** One configured project for a board side (v1.25, ADR-037). */
export interface ProjectRef {
  id: number; // board id
  projectKey: string;
}

/**
 * Parse a "KEY:boardId,KEY2:boardId2" project list (v1.25, ADR-037). Malformed entries
 * (missing key or non-numeric id) are skipped. When the result is empty, returns a
 * single-element list from the fallback key + board id — fully back-compatible.
 */
export function parseProjects(
  raw: string,
  fallbackKey: string,
  fallbackBoardId: string
): ProjectRef[] {
  const out: ProjectRef[] = [];
  for (const part of (raw ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const id = parseInt(trimmed.slice(colon + 1).trim(), 10);
    if (!key || !Number.isFinite(id)) continue;
    out.push({ projectKey: key, id });
  }
  if (out.length === 0) {
    const id = parseInt(fallbackBoardId, 10);
    out.push({ projectKey: fallbackKey, id: Number.isFinite(id) ? id : NaN });
  }
  return out;
}

/** Resolved PO/Dev project lists from config (v1.25). Element 0 = the default project. */
export function getProjects(): { dev: ProjectRef[]; po: ProjectRef[] } {
  const cfg = getConfig();
  return {
    dev: parseProjects(cfg.JIRA_DEV_PROJECTS, cfg.JIRA_DEV_PROJECT_KEY, cfg.JIRA_DEV_BOARD_ID),
    po: parseProjects(cfg.JIRA_PO_PROJECTS, cfg.JIRA_PO_PROJECT_KEY, cfg.JIRA_PO_BOARD_ID),
  };
}

/**
 * Synchronously load dotenv files without polluting the module scope.
 * Package-local .env wins (loaded first); dotenv never overrides already-set vars.
 * Repo-root .env fills the gaps.
 * Skipped when VITEST=true so tests control the env exclusively.
 */
function loadDotenv(): void {
  // In vitest, tests manage process.env directly — skip dotenv loading so
  // test beforeEach/afterEach env manipulation is authoritative.
  if (process.env["VITEST"] === "true") return;

  // Resolve the package root relative to this compiled/source file.
  // In ESM we use import.meta.url for __dirname equivalent.
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  // src/lib/config.ts → ../../  = packages/mcp-jira/
  const packageDir = path.resolve(thisDir, "../..");
  const repoRoot = path.resolve(packageDir, "../..");

  const packageEnv = path.join(packageDir, ".env");
  const rootEnv = path.join(repoRoot, ".env");

  // Load package-local first — dotenv won't override already-set process.env values
  if (fs.existsSync(packageEnv)) {
    dotenv.config({ path: packageEnv });
  }
  // Then repo root fills the gaps
  if (fs.existsSync(rootEnv)) {
    dotenv.config({ path: rootEnv });
  }
}
