// Super-admin console API — v1.45, ADR-055 Phase B. Boots the bridge; keyless/offline.
// Covers: ADMIN_EMAILS bootstrap, requireAdmin (401/403), user supervision, global + per-user
// config CRUD, role promotion, and the "can't demote a bootstrap admin" guard.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resetConfigCache, USER_STORES_DIR } from "../src/lib/config.js";
import { upsertConnection, findUserByEmail } from "../src/lib/userStore.js";
import { seal } from "../src/lib/crypto/secretBox.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invokeboard-admin-"));
const storeFile = path.join(dir, "users.json");

process.env["JIRA_BASE_URL"] = "https://test.atlassian.net";
process.env["JIRA_EMAIL"] = "t@example.com";
process.env["JIRA_API_TOKEN"] = "tok";
process.env["JIRA_PO_BOARD_ID"] = "10001";
process.env["JIRA_DEV_BOARD_ID"] = "10002";
process.env["TOKEN_ENC_KEY"] = Buffer.alloc(32, 7).toString("base64");
process.env["SESSION_SECRET"] = "admin-test-secret";
process.env["TASK_HELPER_FILE"] = storeFile;
process.env["ADMIN_EMAILS"] = "boss@team.com"; // bootstraps the admin role at signup
process.env["VITEST"] = "true";
resetConfigCache();

const { app } = await import("../src/http.js");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});
afterAll(() => {
  server?.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function req(method: string, p: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  const r = await fetch(`${baseUrl}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const h = r.headers as unknown as { getSetCookie?: () => string[] };
  const cookies = h.getSetCookie ? h.getSetCookie() : [r.headers.get("set-cookie") ?? ""];
  const session = cookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("ib_session="));
  const text = await r.text();
  return { status: r.status, text, json: JSON.parse(text) as any, cookie: session ?? null };
}

describe("Admin console API (v1.45, ADR-055)", () => {
  let adminCookie: string;
  let userCookie: string;
  let userId: string;

  beforeAll(async () => {
    const admin = await req("POST", "/api/auth/signup", { email: "boss@team.com", password: "password123" });
    adminCookie = admin.cookie!;
    const user = await req("POST", "/api/auth/signup", { email: "dev@team.com", password: "password123" });
    userCookie = user.cookie!;
  });

  it("bootstraps the admin role for an ADMIN_EMAILS signup", async () => {
    const me = await req("GET", "/api/auth/me", undefined, adminCookie);
    expect(me.json.data.role).toBe("admin");
    const devMe = await req("GET", "/api/auth/me", undefined, userCookie);
    expect(devMe.json.data.role).toBe("user");
  });

  it("401s the admin API without a session", async () => {
    const r = await req("GET", "/api/admin/users");
    expect(r.status).toBe(401);
  });

  it("403s a non-admin user", async () => {
    const r = await req("GET", "/api/admin/users", undefined, userCookie);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("FORBIDDEN");
  });

  it("lists all users with role + connection status for the admin", async () => {
    const r = await req("GET", "/api/admin/users", undefined, adminCookie);
    expect(r.status).toBe(200);
    const emails = r.json.data.users.map((u: { email: string }) => u.email).sort();
    expect(emails).toEqual(["boss@team.com", "dev@team.com"]);
    const dev = r.json.data.users.find((u: { email: string }) => u.email === "dev@team.com");
    userId = dev.id;
    expect(dev.role).toBe("user");
    expect(dev.connections).toEqual({ jira: false, github: false, ai: false });
  });

  it("sets global default config (validated + coerced)", async () => {
    const r = await req("PUT", "/api/admin/config", { JIRA_DEV_BOARD_ID: "12345", JIRA_VELOCITY_SPRINTS: "4" }, adminCookie);
    expect(r.status).toBe(200);
    expect(r.json.data.globalConfig.JIRA_DEV_BOARD_ID).toBe("12345");
    expect(r.json.data.globalConfig.JIRA_VELOCITY_SPRINTS).toBe(4); // coerced to number
  });

  it("rejects invalid global config with 400 VALIDATION", async () => {
    const r = await req("PUT", "/api/admin/config", { JIRA_BASE_URL: "not-a-url" }, adminCookie);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("VALIDATION");
  });

  it("sets a per-user config override", async () => {
    const r = await req("PUT", `/api/admin/users/${userId}/config`, { JIRA_PO_BOARD_ID: "55500" }, adminCookie);
    expect(r.status).toBe(200);
    expect(r.json.data.config.JIRA_PO_BOARD_ID).toBe("55500");
  });

  it("404s a per-user config for an unknown user", async () => {
    const r = await req("PUT", "/api/admin/users/nope/config", { JIRA_PO_BOARD_ID: "1" }, adminCookie);
    expect(r.status).toBe(404);
  });

  it("promotes a user to admin, granting admin API access", async () => {
    const r = await req("PUT", `/api/admin/users/${userId}/role`, { role: "admin" }, adminCookie);
    expect(r.status).toBe(200);
    expect(r.json.data.role).toBe("admin");
    // the promoted user can now reach the admin API
    const now = await req("GET", "/api/admin/users", undefined, userCookie);
    expect(now.status).toBe(200);
  });

  it("refuses to demote an ADMIN_EMAILS bootstrap admin (409)", async () => {
    const boss = await req("GET", "/api/admin/users", undefined, adminCookie);
    const bossId = boss.json.data.users.find((u: { email: string }) => u.email === "boss@team.com").id;
    const r = await req("PUT", `/api/admin/users/${bossId}/role`, { role: "user" }, adminCookie);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("BOOTSTRAP_ADMIN");
  });
});

// ── v1.46 (ADR-056): user CRUD + shared-credential ("POV") users ────────────────

function lendJira(userId: string, token: string, baseUrl: string, email: string) {
  upsertConnection(userId, "jira", {
    enc: seal(token),
    meta: { baseUrl, email, hint: "…lend" },
    updatedAt: new Date().toISOString(),
  });
}

describe("Admin user CRUD + shared credentials (v1.46, ADR-056)", () => {
  let adminCookie: string;
  let bossId: string;
  let viewerId: string;
  let viewerCookie: string;

  beforeAll(async () => {
    const login = await req("POST", "/api/auth/login", { email: "boss@team.com", password: "password123" });
    adminCookie = login.cookie!;
    bossId = findUserByEmail("boss@team.com")!.id;
    // The admin owns a Jira connection that others can borrow.
    lendJira(bossId, "boss-jira-token", "https://boss.atlassian.net", "boss@team.com");
    // GitHub too, so a borrower passes the app-gate readiness check.
    upsertConnection(bossId, "github", {
      enc: seal("boss-gh-token"),
      meta: { login: "boss", hint: "…gh" },
      updatedAt: new Date().toISOString(),
    });
  });

  it("creates a user with NO tokens that borrows the admin's credentials", async () => {
    const r = await req("POST", "/api/admin/users",
      { email: "viewer@team.com", password: "password123", credentialSourceUserId: bossId }, adminCookie);
    expect(r.status).toBe(201);
    expect(r.json.data.sharedFrom).toBe("boss@team.com");
    expect(r.json.data.readOnly).toBe(true); // no writes until an admin grants them
    expect(r.json.data.connections).toEqual({ jira: false, github: false, ai: false }); // owns nothing
    viewerId = r.json.data.id;
  });

  it("rejects a credential source that has no Jira connection to share", async () => {
    const users = await req("GET", "/api/admin/users", undefined, adminCookie);
    const devId = users.json.data.users.find((u: { email: string }) => u.email === "dev@team.com").id;
    const r = await req("POST", "/api/admin/users",
      { email: "nope@team.com", password: "password123", credentialSourceUserId: devId }, adminCookie);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("INVALID_CREDENTIAL_SOURCE");
  });

  it("rejects a duplicate email (409)", async () => {
    const r = await req("POST", "/api/admin/users", { email: "viewer@team.com", password: "password123" }, adminCookie);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("EMAIL_TAKEN");
  });

  it("the borrower signs in and is READY with inherited connections (no tokens of their own)", async () => {
    const login = await req("POST", "/api/auth/login", { email: "viewer@team.com", password: "password123" });
    expect(login.status).toBe(200);
    viewerCookie = login.cookie!;

    const ctx = await req("GET", "/api/me/context", undefined, viewerCookie);
    expect(ctx.status).toBe(200);
    expect(ctx.json.data.ready).toBe(true); // gate passes on borrowed Jira + GitHub
    expect(ctx.json.data.readOnly).toBe(true);
    expect(ctx.json.data.sharedFrom).toBe("boss@team.com");
    expect(ctx.json.data.connections.jira).toMatchObject({ connected: true, inherited: true, via: "boss@team.com" });
    expect(ctx.json.data.connections.jira.hint).toBe(""); // owner's token hint is NOT leaked
  });

  it("blocks Jira-mutating tools for a borrower (403 READ_ONLY_USER)", async () => {
    const r = await req("POST", "/api/tools/update_ticket", { key: "DEV-1", summary: "x" }, viewerCookie);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("READ_ONLY_USER");
  });

  // v1.72 (ADR-083): link_dev_to_po was added to JIRA_WRITE_TOOLS — regression guard.
  it("blocks link_dev_to_po for a borrower (403 READ_ONLY_USER)", async () => {
    const r = await req("POST", "/api/tools/link_dev_to_po", { poKey: "PO-1", devKey: "DEV-1" }, viewerCookie);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("READ_ONLY_USER");
  });

  it("still allows non-Jira (local store) tools for a borrower", async () => {
    const r = await req("POST", "/api/tools/get_retro", {}, viewerCookie);
    expect(r.status).not.toBe(403); // validation may reject the body, but never authorization
  });

  it("an admin can grant writes, unblocking the Jira-mutating tools", async () => {
    const upd = await req("PUT", `/api/admin/users/${viewerId}`, { allowWrites: true }, adminCookie);
    expect(upd.status).toBe(200);
    expect(upd.json.data.allowWrites).toBe(true);
    expect(upd.json.data.readOnly).toBe(false);

    // The write guard now passes; the tool's own input validation rejects the empty body instead.
    const r = await req("POST", "/api/tools/update_ticket", {}, viewerCookie);
    expect(r.status).not.toBe(403);
    expect(r.json.error.code).toBe("VALIDATION");
  });

  it("disabling an account blocks sign-in (403 ACCOUNT_DISABLED)", async () => {
    await req("PUT", `/api/admin/users/${viewerId}`, { disabled: true }, adminCookie);
    const login = await req("POST", "/api/auth/login", { email: "viewer@team.com", password: "password123" });
    expect(login.status).toBe(403);
    expect(login.json.error.code).toBe("ACCOUNT_DISABLED");
    // …and re-enabling restores it
    await req("PUT", `/api/admin/users/${viewerId}`, { disabled: false }, adminCookie);
    const again = await req("POST", "/api/auth/login", { email: "viewer@team.com", password: "password123" });
    expect(again.status).toBe(200);
  });

  it("refuses to delete your own account (409)", async () => {
    const r = await req("DELETE", `/api/admin/users/${bossId}`, undefined, adminCookie);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("CANNOT_DELETE_SELF");
  });

  it("refuses to delete a user whose credentials others borrow (409 IN_USE)", async () => {
    const owner2 = await req("POST", "/api/admin/users", { email: "owner2@team.com", password: "password123" }, adminCookie);
    const owner2Id = owner2.json.data.id;
    lendJira(owner2Id, "owner2-token", "https://o2.atlassian.net", "owner2@team.com");
    const borrower = await req("POST", "/api/admin/users",
      { email: "borrower2@team.com", password: "password123", credentialSourceUserId: owner2Id }, adminCookie);
    expect(borrower.status).toBe(201);

    const blocked = await req("DELETE", `/api/admin/users/${owner2Id}`, undefined, adminCookie);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe("IN_USE");

    // Remove the borrower first, then the owner deletes cleanly.
    expect((await req("DELETE", `/api/admin/users/${borrower.json.data.id}`, undefined, adminCookie)).status).toBe(200);
    const ok = await req("DELETE", `/api/admin/users/${owner2Id}`, undefined, adminCookie);
    expect(ok.status).toBe(200);
    expect(ok.json.data.deleted).toBe(true);
  });

  it("a deleted user is gone from the admin list", async () => {
    const users = await req("GET", "/api/admin/users", undefined, adminCookie);
    const emails = users.json.data.users.map((u: { email: string }) => u.email);
    expect(emails).not.toContain("owner2@team.com");
    expect(emails).not.toContain("borrower2@team.com");
  });
});

// ── v1.67 (ADR-078): granular per-provider sharing + effective status in the admin view ────────

describe("Granular per-provider sharing + effective status (v1.67, ADR-078)", () => {
  let adminCookie: string;
  let bossId: string;

  beforeAll(async () => {
    adminCookie = (await req("POST", "/api/auth/login", { email: "boss@team.com", password: "password123" })).cookie!;
    bossId = findUserByEmail("boss@team.com")!.id;
    // boss already has Jira + GitHub from the earlier describe; add AI too so all three are shareable.
    upsertConnection(bossId, "ai", {
      enc: seal("boss-ai-token"),
      meta: { provider: "github", model: "openai/gpt-4o-mini", hint: "…ai" },
      updatedAt: new Date().toISOString(),
    });
  });

  it("creates a user restricted to sharing only GitHub", async () => {
    const r = await req("POST", "/api/admin/users",
      { email: "partial@team.com", password: "password123", credentialSourceUserId: bossId, sharedProviders: ["github"] },
      adminCookie);
    expect(r.status).toBe(201);
    expect(r.json.data.sharedProviders).toEqual(["github"]);
    expect(r.json.data.effective.github).toEqual({ status: "inherited", via: "boss@team.com" });
    expect(r.json.data.effective.jira).toEqual({ status: "none" }); // NOT shared, even though boss owns Jira
    expect(r.json.data.effective.ai).toEqual({ status: "none" });
  });

  it("updating sharedProviders to null restores share-all", async () => {
    const users = await req("GET", "/api/admin/users", undefined, adminCookie);
    const target = users.json.data.users.find((u: { email: string }) => u.email === "partial@team.com");

    const upd = await req("PUT", `/api/admin/users/${target.id}`, { sharedProviders: null }, adminCookie);
    expect(upd.status).toBe(200);
    expect(upd.json.data.sharedProviders).toBeNull();
    expect(upd.json.data.effective.jira).toEqual({ status: "inherited", via: "boss@team.com" });
    expect(upd.json.data.effective.ai).toEqual({ status: "inherited", via: "boss@team.com" });
  });

  it("effective status reports OWN when the user has their own connection, even while borrowing others", async () => {
    const created = await req("POST", "/api/admin/users",
      { email: "ownjira@team.com", password: "password123", credentialSourceUserId: bossId }, adminCookie);
    const targetId = created.json.data.id;
    upsertConnection(targetId, "jira", {
      enc: seal("own-jira-token"),
      meta: { baseUrl: "https://own.atlassian.net", email: "ownjira@team.com", hint: "…own" },
      updatedAt: new Date().toISOString(),
    });
    const view = await req("GET", "/api/admin/users", undefined, adminCookie);
    const u = view.json.data.users.find((x: { email: string }) => x.email === "ownjira@team.com");
    expect(u.effective.jira).toEqual({ status: "own" });
    expect(u.effective.github).toEqual({ status: "inherited", via: "boss@team.com" }); // still borrowed
  });

  it("reports NONE when a user has neither an own connection nor a credential source", async () => {
    const created = await req("POST", "/api/admin/users", { email: "solo@team.com", password: "password123" }, adminCookie);
    expect(created.json.data.effective).toEqual({
      jira: { status: "none" }, github: { status: "none" }, ai: { status: "none" },
    });
    expect(created.json.data.sharedProviders).toBeNull();
  });
});

// ── v1.47 (ADR-057): reusable admin config templates ──────────────────────────

describe("Admin config templates (v1.47, ADR-057)", () => {
  let adminCookie: string;
  let userCookie: string;
  let templateId: string;
  let devId: string;

  beforeAll(async () => {
    adminCookie = (await req("POST", "/api/auth/login", { email: "boss@team.com", password: "password123" })).cookie!;
    // dev@team.com was promoted to admin earlier; use a fresh plain user for the 403 check
    const plain = await req("POST", "/api/admin/users", { email: "plain@team.com", password: "password123" }, adminCookie);
    devId = plain.json.data.id;
    userCookie = (await req("POST", "/api/auth/login", { email: "plain@team.com", password: "password123" })).cookie!;
  });

  it("403s a non-admin", async () => {
    const r = await req("GET", "/api/admin/templates", undefined, userCookie);
    expect(r.status).toBe(403);
  });

  it("creates a template (numeric fields coerced)", async () => {
    const r = await req("POST", "/api/admin/templates",
      { name: "Team A — Dev", config: { JIRA_DEV_BOARD_ID: "1038", JIRA_VELOCITY_SPRINTS: "6" } }, adminCookie);
    expect(r.status).toBe(201);
    expect(r.json.data.name).toBe("Team A — Dev");
    expect(r.json.data.config.JIRA_VELOCITY_SPRINTS).toBe(6);
    templateId = r.json.data.id;
  });

  it("rejects a duplicate template name (409)", async () => {
    const r = await req("POST", "/api/admin/templates", { name: "Team A — Dev", config: {} }, adminCookie);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("NAME_TAKEN");
  });

  it("rejects an invalid config in a template (400)", async () => {
    const r = await req("POST", "/api/admin/templates", { name: "Bad", config: { JIRA_BASE_URL: "not-a-url" } }, adminCookie);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("VALIDATION");
  });

  it("lists templates", async () => {
    const r = await req("GET", "/api/admin/templates", undefined, adminCookie);
    expect(r.status).toBe(200);
    expect(r.json.data.templates.map((t: { name: string }) => t.name)).toContain("Team A — Dev");
  });

  it("applies a template to a user's config (replace)", async () => {
    const r = await req("POST", `/api/admin/users/${devId}/config/apply-template`, { templateId }, adminCookie);
    expect(r.status).toBe(200);
    expect(r.json.data.config).toEqual({ JIRA_DEV_BOARD_ID: "1038", JIRA_VELOCITY_SPRINTS: 6 });
  });

  it("applies a template over existing config when merge=true", async () => {
    await req("PUT", `/api/admin/users/${devId}/config`, { JIRA_PO_BOARD_ID: "999" }, adminCookie);
    const r = await req("POST", `/api/admin/users/${devId}/config/apply-template`, { templateId, merge: true }, adminCookie);
    expect(r.json.data.config.JIRA_PO_BOARD_ID).toBe("999"); // kept
    expect(r.json.data.config.JIRA_DEV_BOARD_ID).toBe("1038"); // from the template
  });

  it("applies a template to the global defaults", async () => {
    const r = await req("POST", "/api/admin/config/apply-template", { templateId }, adminCookie);
    expect(r.status).toBe(200);
    expect(r.json.data.globalConfig.JIRA_DEV_BOARD_ID).toBe("1038");
  });

  it("404s applying an unknown template", async () => {
    const r = await req("POST", `/api/admin/users/${devId}/config/apply-template`, { templateId: "nope" }, adminCookie);
    expect(r.status).toBe(404);
  });

  it("renames a template and deletes it", async () => {
    const upd = await req("PUT", `/api/admin/templates/${templateId}`, { name: "Team A — Dev (2026)" }, adminCookie);
    expect(upd.json.data.name).toBe("Team A — Dev (2026)");

    expect((await req("DELETE", `/api/admin/templates/${templateId}`, undefined, adminCookie)).status).toBe(200);
    const after = await req("GET", "/api/admin/templates", undefined, adminCookie);
    expect(after.json.data.templates).toHaveLength(0);
    expect((await req("DELETE", `/api/admin/templates/${templateId}`, undefined, adminCookie)).status).toBe(404);
  });
});

// ── v1.47 (ADR-057): personal sprint journal over HTTP ────────────────────────

describe("Personal sprint journal API (v1.47, ADR-057)", () => {
  let cookie: string;
  let todoId: string;
  let journalDir: string;

  beforeAll(async () => {
    cookie = (await req("POST", "/api/auth/login", { email: "boss@team.com", password: "password123" })).cookie!;
    // The journal lives under the package's user-stores dir, keyed by this test user's fresh id.
    journalDir = path.join(USER_STORES_DIR, findUserByEmail("boss@team.com")!.id);
  });

  afterAll(() => {
    try { fs.rmSync(journalDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("401s without a session", async () => {
    expect((await req("GET", "/api/me/journal?sprintId=501")).status).toBe(401);
  });

  it("400s without a valid sprintId", async () => {
    const r = await req("GET", "/api/me/journal", undefined, cookie);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("VALIDATION");
  });

  it("adds a note and reads it back from the feed", async () => {
    const post = await req("POST", "/api/me/journal/notes", { sprintId: 501, text: "Paired on auth" }, cookie);
    expect(post.status).toBe(201);
    expect(post.json.data.text).toBe("Paired on auth");
    expect(post.json.data.createdAt).toBeTruthy();

    const get = await req("GET", "/api/me/journal?sprintId=501", undefined, cookie);
    expect(get.json.data.notes[0].text).toBe("Paired on auth");
  });

  it("rejects an empty note", async () => {
    const r = await req("POST", "/api/me/journal/notes", { sprintId: 501, text: "" }, cookie);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("VALIDATION");
  });

  it("deletes a note entry", async () => {
    const created = await req("POST", "/api/me/journal/notes", { sprintId: 501, text: "throwaway" }, cookie);
    const id = created.json.data.id;
    expect((await req("DELETE", `/api/me/journal/notes/${id}`, undefined, cookie)).status).toBe(200);
    expect((await req("DELETE", `/api/me/journal/notes/${id}`, undefined, cookie)).status).toBe(404);
  });

  it("adds, toggles and deletes a to-do", async () => {
    const created = await req("POST", "/api/me/journal/todos",
      { sprintId: 501, text: "Write tests", ticketKey: "DEV-1" }, cookie);
    expect(created.status).toBe(201);
    expect(created.json.data.done).toBe(false);
    todoId = created.json.data.id;

    const done = await req("PATCH", `/api/me/journal/todos/${todoId}`, { done: true }, cookie);
    expect(done.json.data.done).toBe(true);
    expect(done.json.data.doneAt).toBeTruthy();

    const list = await req("GET", "/api/me/journal?sprintId=501", undefined, cookie);
    expect(list.json.data.todos).toHaveLength(1);
    expect(list.json.data.todos[0].ticketKey).toBe("DEV-1");

    expect((await req("DELETE", `/api/me/journal/todos/${todoId}`, undefined, cookie)).status).toBe(200);
    const after = await req("GET", "/api/me/journal?sprintId=501", undefined, cookie);
    expect(after.json.data.todos).toHaveLength(0);
  });

  it("404s patching a to-do that doesn't exist", async () => {
    const r = await req("PATCH", "/api/me/journal/todos/nope", { done: true }, cookie);
    expect(r.status).toBe(404);
  });
});
