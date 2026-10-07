import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { getConfig, resetConfigCache, parseProjects, getStorageSqliteFilePath } from "../src/lib/config.js";
import { ConfigError } from "../src/lib/errors.js";

describe("parseProjects (v1.25, ADR-037)", () => {
  it("parses a KEY:boardId,KEY2:boardId2 list in order", () => {
    expect(parseProjects("VRDB:1038,OTHER:1234", "DEV", "1")).toEqual([
      { projectKey: "VRDB", id: 1038 },
      { projectKey: "OTHER", id: 1234 },
    ]);
  });

  it("falls back to a 1-element list from the single key + board id when empty", () => {
    expect(parseProjects("", "DEV", "1038")).toEqual([{ projectKey: "DEV", id: 1038 }]);
    expect(parseProjects("   ", "PO", "10")).toEqual([{ projectKey: "PO", id: 10 }]);
  });

  it("skips malformed entries (no colon, missing key, non-numeric id) but keeps valid ones", () => {
    expect(parseProjects("VRDB:1038, bad, :9, KEY:notnum, OK:7", "DEV", "1")).toEqual([
      { projectKey: "VRDB", id: 1038 },
      { projectKey: "OK", id: 7 },
    ]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseProjects("  A : 1 ,  B:2 ", "DEV", "9")).toEqual([
      { projectKey: "A", id: 1 },
      { projectKey: "B", id: 2 },
    ]);
  });
});

// Save and restore process.env around each test
const originalEnv = { ...process.env };

beforeEach(() => {
  resetConfigCache();
  // Clear all Jira-related env vars
  delete process.env["JIRA_BASE_URL"];
  delete process.env["JIRA_EMAIL"];
  delete process.env["JIRA_API_TOKEN"];
  delete process.env["JIRA_PO_PROJECT_KEY"];
  delete process.env["JIRA_DEV_PROJECT_KEY"];
  delete process.env["JIRA_PO_BOARD_ID"];
  delete process.env["JIRA_DEV_BOARD_ID"];
  delete process.env["JIRA_STORY_POINTS_FIELD"];
  delete process.env["JIRA_LINK_TYPE"];
  delete process.env["JIRA_FLAGGED_FIELD"];
  delete process.env["MCP_JIRA_HTTP_PORT"];
});

afterEach(() => {
  // Restore original env
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  resetConfigCache();
});

function setRequiredVars() {
  process.env["JIRA_BASE_URL"] = "https://test.atlassian.net";
  process.env["JIRA_EMAIL"] = "test@example.com";
  process.env["JIRA_API_TOKEN"] = "test-token";
  process.env["JIRA_PO_BOARD_ID"] = "10001";
  process.env["JIRA_DEV_BOARD_ID"] = "10002";
}

describe("getConfig", () => {
  it("throws ConfigError listing missing required vars", () => {
    // All required vars missing
    let error: unknown;
    try {
      getConfig();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const cfg = error as ConfigError;
    expect(cfg.missingVars).toContain("JIRA_BASE_URL");
    expect(cfg.missingVars).toContain("JIRA_EMAIL");
    expect(cfg.missingVars).toContain("JIRA_API_TOKEN");
  });

  it("names the specific missing vars in the error message", () => {
    process.env["JIRA_BASE_URL"] = "https://test.atlassian.net";
    process.env["JIRA_EMAIL"] = "test@example.com";
    // JIRA_API_TOKEN still missing + board IDs missing
    let error: unknown;
    try {
      getConfig();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const msg = (error as ConfigError).message;
    expect(msg).toContain("JIRA_API_TOKEN");
  });

  it("succeeds when all required vars are set", () => {
    setRequiredVars();
    const cfg = getConfig();
    expect(cfg.JIRA_BASE_URL).toBe("https://test.atlassian.net");
    expect(cfg.JIRA_EMAIL).toBe("test@example.com");
  });

  it("applies defaults for optional vars", () => {
    setRequiredVars();
    const cfg = getConfig();
    expect(cfg.JIRA_PO_PROJECT_KEY).toBe("PO");
    expect(cfg.JIRA_DEV_PROJECT_KEY).toBe("DEV");
    expect(cfg.JIRA_STORY_POINTS_FIELD).toBe("customfield_10016");
    expect(cfg.JIRA_LINK_TYPE).toBe("Depends on"); // v1.42 (ADR-046): exact link-type name; PO "depends on" Dev
    expect(cfg.JIRA_FLAGGED_FIELD).toBe("");
    expect(cfg.MCP_JIRA_HTTP_PORT).toBe(4001);
  });

  it("respects overridden optional vars", () => {
    setRequiredVars();
    process.env["JIRA_PO_PROJECT_KEY"] = "MYPO";
    process.env["MCP_JIRA_HTTP_PORT"] = "9999";
    const cfg = getConfig();
    expect(cfg.JIRA_PO_PROJECT_KEY).toBe("MYPO");
    expect(cfg.MCP_JIRA_HTTP_PORT).toBe(9999);
  });

  it("caches the config after first call", () => {
    setRequiredVars();
    const cfg1 = getConfig();
    // Change env after first call — should not affect cached result
    process.env["JIRA_BASE_URL"] = "https://changed.atlassian.net";
    const cfg2 = getConfig();
    expect(cfg1).toBe(cfg2); // same object reference
    expect(cfg2.JIRA_BASE_URL).toBe("https://test.atlassian.net");
  });

  it("resetConfigCache() allows re-reading env", () => {
    setRequiredVars();
    getConfig();
    resetConfigCache();
    process.env["JIRA_BASE_URL"] = "https://new.atlassian.net";
    const cfg = getConfig();
    expect(cfg.JIRA_BASE_URL).toBe("https://new.atlassian.net");
  });
});

describe("STORAGE_DRIVER / STORAGE_SQLITE_FILE (v1.65, ADR-077)", () => {
  it("STORAGE_DRIVER defaults to json", () => {
    setRequiredVars();
    expect(getConfig().STORAGE_DRIVER).toBe("json");
  });

  it("accepts sqlite", () => {
    setRequiredVars();
    process.env["STORAGE_DRIVER"] = "sqlite";
    expect(getConfig().STORAGE_DRIVER).toBe("sqlite");
  });

  it("rejects an unrecognized STORAGE_DRIVER value", () => {
    setRequiredVars();
    process.env["STORAGE_DRIVER"] = "postgres";
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("getStorageSqliteFilePath() resolves the default filename relative to the package dir", () => {
    setRequiredVars();
    const p = getStorageSqliteFilePath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.endsWith(path.join("mcp-jira", ".invokeboard-stores.sqlite"))).toBe(true);
  });

  it("getStorageSqliteFilePath() uses an absolute STORAGE_SQLITE_FILE as-is", () => {
    setRequiredVars();
    const absolute = path.join(path.sep, "data", "stores.sqlite");
    process.env["STORAGE_SQLITE_FILE"] = absolute;
    expect(getStorageSqliteFilePath()).toBe(path.resolve(absolute));
  });

  it("getStorageSqliteFilePath() resolves a relative STORAGE_SQLITE_FILE against the package dir", () => {
    setRequiredVars();
    process.env["STORAGE_SQLITE_FILE"] = "custom.sqlite";
    const p = getStorageSqliteFilePath();
    expect(p.endsWith(path.join("mcp-jira", "custom.sqlite"))).toBe(true);
  });
});

describe("STORAGE_DRIVER=mysql / STORAGE_MYSQL_URL (v1.74, ADR-085)", () => {
  it("accepts mysql with a connection URL", () => {
    setRequiredVars();
    process.env["STORAGE_DRIVER"] = "mysql";
    process.env["STORAGE_MYSQL_URL"] = "mysql://u:p@mysql:3306/invokeboard";
    const cfg = getConfig();
    expect(cfg.STORAGE_DRIVER).toBe("mysql");
    expect(cfg.STORAGE_MYSQL_URL).toBe("mysql://u:p@mysql:3306/invokeboard");
  });

  it("fails fast with a ConfigError naming STORAGE_MYSQL_URL when mysql has no URL", () => {
    setRequiredVars();
    process.env["STORAGE_DRIVER"] = "mysql";
    delete process.env["STORAGE_MYSQL_URL"];
    expect(() => getConfig()).toThrow(ConfigError);
    resetConfigCache();
    process.env["STORAGE_MYSQL_URL"] = "   ";
    expect(() => getConfig()).toThrow(/STORAGE_MYSQL_URL/);
  });

  it("does not require STORAGE_MYSQL_URL for the json/sqlite drivers", () => {
    setRequiredVars();
    process.env["STORAGE_DRIVER"] = "sqlite";
    delete process.env["STORAGE_MYSQL_URL"];
    expect(getConfig().STORAGE_MYSQL_URL).toBe("");
  });
});
