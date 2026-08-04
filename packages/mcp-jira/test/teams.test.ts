// Teams — a shared team scope (v1.73, ADR-084). Keyless/offline.
//
// A team is a THIRD scope input, independent of ADR-056 credential delegation: team decides
// storage SCOPE, delegation still decides CREDENTIALS. Teams live inside the existing `users`
// doc (the proven ADR-057 configTemplates pattern) — no new store, no new env var.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resetConfigCache, USER_STORES_DIR } from "../src/lib/config.js";
import {
  createUser,
  upsertConnection,
  updateUser,
  findUserById,
  createTeam,
  updateTeam,
  deleteTeam,
  findTeamById,
  findTeamByName,
  listTeams,
  listUsersByTeam,
  teamScope,
  setUserConfig,
} from "../src/lib/userStore.js";
import { resolveUser } from "../src/lib/userConfig.js";
import { seal } from "../src/lib/crypto/secretBox.js";
import { adoptScopeDocs } from "../src/lib/storage/adopt.js";
import { readDoc, writeDoc } from "../src/lib/storage/index.js";

let dir: string;
let storeFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "invokeboard-teams-"));
  storeFile = path.join(dir, "users.json");
  process.env["JIRA_BASE_URL"] = "https://global.atlassian.net";
  process.env["JIRA_EMAIL"] = "global@example.com";
  process.env["JIRA_API_TOKEN"] = "global-token";
  process.env["JIRA_PO_BOARD_ID"] = "10001";
  process.env["JIRA_DEV_BOARD_ID"] = "10002";
  process.env["TOKEN_ENC_KEY"] = Buffer.alloc(32, 3).toString("base64");
  process.env["SESSION_SECRET"] = "teams-test-secret";
  process.env["TASK_HELPER_FILE"] = storeFile;
  resetConfigCache();
});

afterEach(() => {
  delete process.env["TASK_HELPER_FILE"];
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function connectJira(userId: string, baseUrl = "https://team.atlassian.net", email = "team@example.com"): void {
  upsertConnection(userId, "jira", {
    enc: seal(`token-for-${userId}`),
    meta: { baseUrl, email, hint: "…oken" },
    updatedAt: new Date().toISOString(),
  });
}

describe("Team CRUD (v1.73, ADR-084)", () => {
  it("round-trips through create/find/list/delete", () => {
    const team = createTeam("Team Falcon", { JIRA_DEV_BOARD_ID: "5001" });
    expect(team.id).toBeTruthy();
    expect(team.name).toBe("Team Falcon");
    expect(team.config).toEqual({ JIRA_DEV_BOARD_ID: "5001" });
    expect(team.createdAt).toBe(team.updatedAt);

    expect(findTeamById(team.id)).toEqual(team);
    expect(listTeams().map((t) => t.id)).toContain(team.id);

    expect(deleteTeam(team.id)).toBe(true);
    expect(findTeamById(team.id)).toBeNull();
  });

  it("defaults config to {} when omitted, and trims the name", () => {
    const team = createTeam("  Team Beta  ");
    expect(team.name).toBe("Team Beta");
    expect(team.config).toEqual({});
  });

  it("lists teams sorted by name", () => {
    createTeam("Zeta");
    createTeam("Alpha");
    createTeam("Mu");
    const names = listTeams().map((t) => t.name);
    expect(names).toEqual(["Alpha", "Mu", "Zeta"]);
  });

  it("findTeamByName is case-insensitive and trims whitespace", () => {
    const team = createTeam("Team Falcon");
    expect(findTeamByName("team falcon")).toEqual(team);
    expect(findTeamByName("  TEAM FALCON  ")).toEqual(team);
    expect(findTeamByName("nope")).toBeNull();
  });

  it("updateTeam bumps updatedAt and patches name/config independently", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const team = createTeam("Original Name", { JIRA_DEV_BOARD_ID: "1111" });
      const createdAt = team.createdAt;

      vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
      const renamed = updateTeam(team.id, { name: "Renamed" });
      expect(renamed?.name).toBe("Renamed");
      expect(renamed?.config).toEqual({ JIRA_DEV_BOARD_ID: "1111" }); // untouched
      expect(renamed?.createdAt).toBe(createdAt); // never changes
      expect(renamed?.updatedAt).not.toBe(createdAt);
      expect(new Date(renamed!.updatedAt).getTime()).toBeGreaterThan(new Date(createdAt).getTime());

      const reconfigured = updateTeam(team.id, { config: { JIRA_DEV_BOARD_ID: "2222" } });
      expect(reconfigured?.name).toBe("Renamed"); // untouched by this patch
      expect(reconfigured?.config).toEqual({ JIRA_DEV_BOARD_ID: "2222" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("updateTeam returns null for an unknown id", () => {
    expect(updateTeam("does-not-exist", { name: "X" })).toBeNull();
  });

  it("deleteTeam returns false for an unknown id", () => {
    expect(deleteTeam("does-not-exist")).toBe(false);
  });
});

describe("teamScope (v1.73, ADR-084)", () => {
  it("prefixes the team id with 'team-'", () => {
    expect(teamScope("abc")).toBe("team-abc");
  });
});

describe("listUsersByTeam (v1.73, ADR-084)", () => {
  it("returns only members of the given team", () => {
    const teamA = createTeam("Team A");
    const teamB = createTeam("Team B");
    const alice = createUser("alice@team.com", "hash");
    const bob = createUser("bob@team.com", "hash");
    const carl = createUser("carl@team.com", "hash");
    updateUser(alice.id, { teamId: teamA.id });
    updateUser(bob.id, { teamId: teamA.id });
    updateUser(carl.id, { teamId: teamB.id });

    const membersA = listUsersByTeam(teamA.id).map((u) => u.id).sort();
    expect(membersA).toEqual([alice.id, bob.id].sort());
    expect(listUsersByTeam(teamB.id).map((u) => u.id)).toEqual([carl.id]);
    expect(listUsersByTeam("no-such-team")).toEqual([]);
  });
});

describe("updateUser teamId (v1.73, ADR-084)", () => {
  it("sets and then clears teamId with the null-clears convention", () => {
    const team = createTeam("Team Falcon");
    const user = createUser("dana@team.com", "hash");
    expect(user.teamId).toBeUndefined();

    const withTeam = updateUser(user.id, { teamId: team.id });
    expect(withTeam?.teamId).toBe(team.id);
    expect(findUserById(user.id)?.teamId).toBe(team.id);

    const cleared = updateUser(user.id, { teamId: null });
    expect(cleared?.teamId).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(cleared, "teamId")).toBe(false);
    expect(findUserById(user.id)?.teamId).toBeUndefined();
  });
});

describe("legacy tolerance — users doc without a teams key (v1.73, ADR-084)", () => {
  it("reads back with teams === {} and doesn't crash create/list", () => {
    // Simulate a pre-v1.73 users.json: no `teams` key at all.
    fs.writeFileSync(
      storeFile,
      JSON.stringify({
        users: {},
        connections: {},
        globalConfig: {},
        userConfigs: {},
        configTemplates: {},
      }),
      "utf8"
    );

    expect(listTeams()).toEqual([]);
    const team = createTeam("New Team");
    expect(listTeams().map((t) => t.id)).toEqual([team.id]);
  });
});

describe("resolveUser team scoping (v1.73, ADR-084)", () => {
  it("scopes storeUserId to the team for a member who owns their own Jira connection", () => {
    const team = createTeam("Team Falcon");
    const user = createUser("erin@team.com", "hash");
    connectJira(user.id);
    updateUser(user.id, { teamId: team.id });

    const resolved = resolveUser(user.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.storeUserId).toBe(teamScope(team.id));
  });

  it("falls back to userId when teamId points at a DELETED team (defensive, never crashes)", () => {
    const team = createTeam("Ghost Team");
    const user = createUser("frank@team.com", "hash");
    connectJira(user.id);
    updateUser(user.id, { teamId: team.id });
    expect(deleteTeam(team.id)).toBe(true);

    const resolved = resolveUser(user.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.storeUserId).toBe(user.id);
  });

  it("team config lands in the merged config, and a per-user override beats the team config", () => {
    const team = createTeam("Team Config", { JIRA_DEV_BOARD_ID: "5001", JIRA_PO_BOARD_ID: "5000" });
    const user = createUser("grace@team.com", "hash");
    connectJira(user.id);
    updateUser(user.id, { teamId: team.id });

    const beforeOverride = resolveUser(user.id);
    expect(beforeOverride!.config.JIRA_DEV_BOARD_ID).toBe("5001");
    expect(beforeOverride!.config.JIRA_PO_BOARD_ID).toBe("5000");

    setUserConfig(user.id, { JIRA_DEV_BOARD_ID: "6001" });
    const afterOverride = resolveUser(user.id);
    expect(afterOverride!.config.JIRA_DEV_BOARD_ID).toBe("6001"); // per-user override wins
    expect(afterOverride!.config.JIRA_PO_BOARD_ID).toBe("5000"); // team config still applies
  });
});

describe("adoptScopeDocs (v1.73, ADR-084)", () => {
  // These scopes go through the real json driver's per-user path formula
  // (<USER_STORES_DIR>/<scope>/<name>.json), so — like journal.test.ts — clean them up on both
  // sides of every test rather than leaving fixed-name fixtures on disk.
  function cleanAdoptScopes(): void {
    fs.rmSync(path.join(USER_STORES_DIR, "userA"), { recursive: true, force: true });
    fs.rmSync(path.join(USER_STORES_DIR, "team-x"), { recursive: true, force: true });
  }

  beforeEach(cleanAdoptScopes);
  afterEach(cleanAdoptScopes);

  it("copies docs present at the source, skips absent ones, never overwrites the target, and is idempotent", () => {
    writeDoc("userA", "leaves", { entries: [{ id: "1" }] });
    writeDoc("userA", "retro", { items: ["went well"] });
    // "impediments" deliberately absent at the source.
    writeDoc("team-x", "retro", { items: ["already here, must not be overwritten"] });

    const first = adoptScopeDocs("userA", "team-x", ["leaves", "retro", "impediments"]);
    expect(first.copied.sort()).toEqual(["leaves"]);
    expect(first.skipped.sort()).toEqual(["impediments", "retro"]);

    expect(readDoc("team-x", "leaves")).toEqual({ entries: [{ id: "1" }] });
    // Target's pre-existing retro doc is untouched.
    expect(readDoc("team-x", "retro")).toEqual({ items: ["already here, must not be overwritten"] });

    const second = adoptScopeDocs("userA", "team-x", ["leaves", "retro", "impediments"]);
    expect(second.copied).toEqual([]);
    expect(second.skipped.sort()).toEqual(["impediments", "leaves", "retro"]);
  });

  it("returns empty copied/skipped for an empty names list", () => {
    expect(adoptScopeDocs("userA", "team-x", [])).toEqual({ copied: [], skipped: [] });
  });
});
