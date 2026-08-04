// Per-user request scoping (v1.45, ADR-055) — AsyncLocalStorage + context-aware getConfig +
// per-user store paths + resolveUserConfig. Keyless/offline.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getConfig, resetConfigCache, getLeavesFilePath, getRetroFilePath, USER_STORES_DIR,
} from "../src/lib/config.js";
import { runWithUser, getRequestUserId, getRequestStoreUserId } from "../src/lib/requestContext.js";
import { resolveUserConfig, resolveUser } from "../src/lib/userConfig.js";
import {
  createUser, upsertConnection, setGlobalConfig, setUserConfig, createTeam, updateUser, teamScope,
} from "../src/lib/userStore.js";
import { seal } from "../src/lib/crypto/secretBox.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "invokeboard-rc-"));
  process.env["JIRA_BASE_URL"] = "https://global.atlassian.net";
  process.env["JIRA_EMAIL"] = "global@example.com";
  process.env["JIRA_API_TOKEN"] = "global-token";
  process.env["JIRA_PO_BOARD_ID"] = "10001";
  process.env["JIRA_DEV_BOARD_ID"] = "10002";
  process.env["TOKEN_ENC_KEY"] = Buffer.alloc(32, 5).toString("base64");
  process.env["SESSION_SECRET"] = "rc-secret";
  process.env["TASK_HELPER_FILE"] = path.join(dir, "users.json");
  resetConfigCache();
});

afterEach(() => {
  delete process.env["TASK_HELPER_FILE"];
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("request context (ADR-055)", () => {
  it("getConfig() returns the global .env config outside any user context", () => {
    expect(getConfig().JIRA_API_TOKEN).toBe("global-token");
    expect(getConfig().JIRA_BASE_URL).toBe("https://global.atlassian.net");
  });

  it("getConfig() returns the per-user config inside runWithUser", () => {
    const userCfg = { ...getConfig(), JIRA_API_TOKEN: "user-A-token", JIRA_BASE_URL: "https://a.atlassian.net" };
    runWithUser({ userId: "userA", config: userCfg }, () => {
      expect(getConfig().JIRA_API_TOKEN).toBe("user-A-token");
      expect(getConfig().JIRA_BASE_URL).toBe("https://a.atlassian.net");
    });
    // and reverts outside the context
    expect(getConfig().JIRA_API_TOKEN).toBe("global-token");
  });

  it("store paths are namespaced per user inside a context, shared outside", () => {
    expect(getLeavesFilePath()).toContain(".invokeboard-leaves.json"); // shared default
    runWithUser({ userId: "userB", config: getConfig() }, () => {
      const p = getLeavesFilePath();
      expect(p.startsWith(USER_STORES_DIR)).toBe(true);
      expect(p).toContain(path.join("userB", "leaves.json"));
      // a different store for the same user lands in the same dir
      expect(getRetroFilePath()).toContain(path.join("userB", "retro.json"));
    });
  });

  it("two users get isolated store paths (no board-id collisions)", () => {
    let a = "", b = "";
    runWithUser({ userId: "u1", config: getConfig() }, () => { a = getLeavesFilePath(); });
    runWithUser({ userId: "u2", config: getConfig() }, () => { b = getLeavesFilePath(); });
    expect(a).not.toBe(b);
    expect(a).toContain("u1");
    expect(b).toContain("u2");
  });

  it("resolveUserConfig builds a Config from the user's own Jira connection", () => {
    const user = createUser("alice@team.com", "hash");
    upsertConnection(user.id, "jira", {
      enc: seal("alice-jira-token"),
      meta: { baseUrl: "https://alice.atlassian.net", email: "alice@team.com", hint: "…oken" },
      updatedAt: new Date().toISOString(),
    });
    const cfg = resolveUserConfig(user.id);
    expect(cfg).not.toBeNull();
    expect(cfg!.JIRA_API_TOKEN).toBe("alice-jira-token"); // decrypted, per-user
    expect(cfg!.JIRA_BASE_URL).toBe("https://alice.atlassian.net");
    expect(cfg!.JIRA_EMAIL).toBe("alice@team.com");
    // inherits global tuning defaults
    expect(cfg!.JIRA_DEV_BOARD_ID).toBe("10002");
  });

  it("resolveUserConfig returns null when the user has no Jira connection", () => {
    const user = createUser("nobody@team.com", "hash");
    expect(resolveUserConfig(user.id)).toBeNull();
  });

  it("resolveUserConfig merges admin global defaults ← per-user overrides ← the user's Jira creds (Phase B)", () => {
    const user = createUser("bob@team.com", "hash");
    upsertConnection(user.id, "jira", {
      enc: seal("bob-jira-token"),
      meta: { baseUrl: "https://bob.atlassian.net", email: "bob@team.com", hint: "…oken" },
      updatedAt: new Date().toISOString(),
    });
    // Admin sets a global board id for everyone, then a per-user PO-board override for Bob.
    setGlobalConfig({ JIRA_DEV_BOARD_ID: "9001", JIRA_PO_BOARD_ID: "9000", JIRA_VELOCITY_SPRINTS: 3 });
    setUserConfig(user.id, { JIRA_PO_BOARD_ID: "9999", JIRA_LINK_TYPE: "Blocks" });

    const cfg = resolveUserConfig(user.id);
    expect(cfg).not.toBeNull();
    expect(cfg!.JIRA_DEV_BOARD_ID).toBe("9001"); // from admin global default
    expect(cfg!.JIRA_PO_BOARD_ID).toBe("9999"); // per-user override wins over global
    expect(cfg!.JIRA_VELOCITY_SPRINTS).toBe(3); // numeric field coerced + applied
    expect(cfg!.JIRA_LINK_TYPE).toBe("Blocks"); // per-user override
    // the user's own connection still wins for base/email/token
    expect(cfg!.JIRA_API_TOKEN).toBe("bob-jira-token");
    expect(cfg!.JIRA_BASE_URL).toBe("https://bob.atlassian.net");
  });
});

describe("team scoping inside the request context (v1.73, ADR-084)", () => {
  function connectJira(userId: string): void {
    upsertConnection(userId, "jira", {
      enc: seal(`token-for-${userId}`),
      meta: { baseUrl: "https://team.atlassian.net", email: `${userId}@team.com`, hint: "…oken" },
      updatedAt: new Date().toISOString(),
    });
  }

  it("two users in the SAME team resolve to the SAME storeUserId (and therefore the same store paths)", () => {
    const team = createTeam("Team Falcon");
    const alice = createUser("alice@falcon.com", "hash");
    const bob = createUser("bob@falcon.com", "hash");
    connectJira(alice.id);
    connectJira(bob.id);
    updateUser(alice.id, { teamId: team.id });
    updateUser(bob.id, { teamId: team.id });

    const rAlice = resolveUser(alice.id)!;
    const rBob = resolveUser(bob.id)!;
    expect(rAlice.storeUserId).toBe(teamScope(team.id));
    expect(rAlice.storeUserId).toBe(rBob.storeUserId);

    let aliceLeavesPath = "";
    let bobLeavesPath = "";
    runWithUser({ userId: alice.id, config: rAlice.config, storeUserId: rAlice.storeUserId }, () => {
      aliceLeavesPath = getLeavesFilePath();
    });
    runWithUser({ userId: bob.id, config: rBob.config, storeUserId: rBob.storeUserId }, () => {
      bobLeavesPath = getLeavesFilePath();
    });
    expect(aliceLeavesPath).toBe(bobLeavesPath);
    expect(aliceLeavesPath).toContain(path.join(teamScope(team.id), "leaves.json"));
  });

  it("two DIFFERENT teams are isolated from each other", () => {
    const teamA = createTeam("Team A");
    const teamB = createTeam("Team B");
    const alice = createUser("alice@a.com", "hash");
    const carl = createUser("carl@b.com", "hash");
    connectJira(alice.id);
    connectJira(carl.id);
    updateUser(alice.id, { teamId: teamA.id });
    updateUser(carl.id, { teamId: teamB.id });

    const rAlice = resolveUser(alice.id)!;
    const rCarl = resolveUser(carl.id)!;
    expect(rAlice.storeUserId).not.toBe(rCarl.storeUserId);
    expect(rAlice.storeUserId).toBe(teamScope(teamA.id));
    expect(rCarl.storeUserId).toBe(teamScope(teamB.id));
  });

  it("a team member's journal still resolves to their own real userId inside runWithUser", () => {
    const team = createTeam("Team Falcon");
    const dana = createUser("dana@falcon.com", "hash");
    connectJira(dana.id);
    updateUser(dana.id, { teamId: team.id });

    const r = resolveUser(dana.id)!;
    expect(r.storeUserId).toBe(teamScope(team.id)); // shared team scope for storage
    runWithUser({ userId: dana.id, config: r.config, storeUserId: r.storeUserId }, () => {
      // journalStore.ts takes userId explicitly — getRequestUserId() (the REAL identity),
      // never getRequestStoreUserId() — so personal notes stay per-user even under a team.
      expect(getRequestUserId()).toBe(dana.id);
      expect(getRequestStoreUserId()).toBe(teamScope(team.id));
    });
  });
});
