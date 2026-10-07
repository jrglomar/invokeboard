/**
 * MySQL storage driver + doc bundle tests (v1.74, ADR-085). Keyless/offline: the driver runs against
 * an in-memory fake pool (helpers/fakeMysqlPool.ts), and `mysql2/promise` is vi.mock'ed so the
 * default-pool path is exercised without a network. The shared json/sqlite/mysql contract suite
 * lives in storage.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createMysqlDriver, redactMysqlUrl } from "../src/lib/storage/mysqlDriver.js";
import { SHARED_SCOPE } from "../src/lib/storage/port.js";
import {
  BUNDLE_FORMAT,
  makeBundle,
  parseBundle,
  stableStringify,
  type BundleDoc,
} from "../src/lib/storage/bundle.js";
import { createFakeMysqlPool, type FakeRow } from "./helpers/fakeMysqlPool.js";

const createPoolMock = vi.hoisted(() => vi.fn());
vi.mock("mysql2/promise", () => ({ createPool: createPoolMock }));

const quiet = { log: () => {}, logError: () => {} };

describe("mysql driver — lifecycle (v1.74)", () => {
  beforeEach(() => {
    createPoolMock.mockReset();
  });

  it("throws a clear error when used before init()", () => {
    const driver = createMysqlDriver("mysql://x", { pool: createFakeMysqlPool(), ...quiet });
    expect(() => driver.readDoc(SHARED_SCOPE, "leaves")).toThrow(/initStorage/);
    expect(() => driver.writeDoc(SHARED_SCOPE, "leaves", {})).toThrow(/initStorage/);
  });

  it("preloads every row on init — string (LONGTEXT) and pre-parsed object data alike", async () => {
    const rows = new Map<string, FakeRow>([
      ["shared\u0000leaves", { scope: "shared", name: "leaves", data: '{"1":{"Ann":{}}}', updated_at: new Date() }],
      ["u1\u0000journal", { scope: "u1", name: "journal", data: { entries: [1, 2] }, updated_at: new Date() }],
    ]);
    const log = vi.fn();
    const driver = createMysqlDriver("mysql://app:secret@db:3306/ib", { pool: createFakeMysqlPool(rows), log });
    await driver.init();

    expect(driver.countDocs()).toBe(2);
    expect(driver.readDoc("shared", "leaves")).toEqual({ "1": { Ann: {} } });
    expect(driver.readDoc("u1", "journal")).toEqual({ entries: [1, 2] });
    const msg = log.mock.calls.map((c) => c[0]).join("\n");
    expect(msg).toContain("loaded 2 doc(s)");
    expect(msg).not.toContain("secret"); // password redacted in the startup log
  });

  it("init() is idempotent (one preload) and returns a fresh object per read", async () => {
    const pool = createFakeMysqlPool();
    const querySpy = vi.spyOn(pool, "query");
    const driver = createMysqlDriver("mysql://x", { pool, ...quiet });
    await Promise.all([driver.init(), driver.init()]);
    expect(querySpy).toHaveBeenCalledTimes(2); // CREATE + SELECT, once

    driver.writeDoc(SHARED_SCOPE, "team", { members: ["a"] });
    const first = driver.readDoc(SHARED_SCOPE, "team") as { members: string[] };
    first.members.push("mutated");
    expect(driver.readDoc(SHARED_SCOPE, "team")).toEqual({ members: ["a"] });
  });

  it("persists writes behind the cache: a fresh driver on the same database reads them back", async () => {
    const rows = new Map<string, FakeRow>();
    const a = createMysqlDriver("mysql://x", { pool: createFakeMysqlPool(rows), ...quiet });
    await a.init();
    a.writeDoc(SHARED_SCOPE, "retro", { went: "well" });
    a.writeDoc("u9", "journal", { notes: "hi" });
    await a.flush();
    expect(a.pendingCount()).toBe(0);

    const b = createMysqlDriver("mysql://x", { pool: createFakeMysqlPool(rows), ...quiet }); // "restart"
    await b.init();
    expect(b.readDoc(SHARED_SCOPE, "retro")).toEqual({ went: "well" });
    expect(b.readDoc("u9", "journal")).toEqual({ notes: "hi" });
  });

  it("coalesces repeated writes to one key while a write is in flight (latest value wins)", async () => {
    const pool = createFakeMysqlPool();
    const driver = createMysqlDriver("mysql://x", { pool, ...quiet });
    await driver.init();

    driver.writeDoc(SHARED_SCOPE, "offset", { v: 1 }); // starts the pump immediately
    driver.writeDoc(SHARED_SCOPE, "offset", { v: 2 }); // queued…
    driver.writeDoc(SHARED_SCOPE, "offset", { v: 3 }); // …replaced in place
    await driver.flush();

    expect(pool.upserts).toBe(2); // v1 + v3; v2 never hit the database
    expect(JSON.parse(pool.rows.get("shared\u0000offset")!.data as string)).toEqual({ v: 3 });
  });

  it("retries a failed upsert with backoff without throwing from writeDoc", async () => {
    const pool = createFakeMysqlPool();
    const logError = vi.fn();
    const driver = createMysqlDriver("mysql://x", { pool, log: () => {}, logError, retryBaseMs: 1 });
    await driver.init();
    pool.failNext = 2;

    expect(() => driver.writeDoc(SHARED_SCOPE, "prs", ["#1"])).not.toThrow();
    expect(driver.readDoc(SHARED_SCOPE, "prs")).toEqual(["#1"]); // cache is authoritative meanwhile
    await driver.flush();

    expect(logError).toHaveBeenCalledTimes(2);
    expect(logError.mock.calls[0]![0]).toMatch(/write FAILED for scope=shared name=prs/);
    expect(JSON.parse(pool.rows.get("shared\u0000prs")!.data as string)).toEqual(["#1"]);
  });

  it("flush() gives up after its timeout and reports what was not persisted", async () => {
    const pool = createFakeMysqlPool();
    const logError = vi.fn();
    const driver = createMysqlDriver("mysql://x", {
      pool,
      log: () => {},
      logError,
      retryBaseMs: 5,
      retryMaxMs: 5,
      flushTimeoutMs: 30,
    });
    await driver.init();
    pool.failNext = Number.POSITIVE_INFINITY;
    driver.writeDoc(SHARED_SCOPE, "leaves", { x: 1 });

    await driver.flush();
    expect(driver.pendingCount()).toBe(1);
    expect(logError.mock.calls.some((c) => /1 write\(s\) NOT persisted/.test(c[0]))).toBe(true);

    pool.failNext = 0; // database "comes back" — the pump drains on its next retry
    await driver.flush();
    expect(driver.pendingCount()).toBe(0);
    expect(pool.rows.has("shared\u0000leaves")).toBe(true);
  });

  it("preserves object key insertion order across a restart (text column, not native JSON)", async () => {
    const rows = new Map<string, FakeRow>();
    const a = createMysqlDriver("mysql://x", { pool: createFakeMysqlPool(rows), ...quiet });
    await a.init();
    a.writeDoc(SHARED_SCOPE, "leaves", { "12": 1, "3": 2, b: 3, a: 4 });
    await a.flush();

    const b = createMysqlDriver("mysql://x", { pool: createFakeMysqlPool(rows), ...quiet });
    await b.init();
    expect(Object.keys(b.readDoc(SHARED_SCOPE, "leaves") as object)).toEqual(["3", "12", "b", "a"]);
  });

  it("close() flushes then ends the pool", async () => {
    const pool = createFakeMysqlPool();
    const driver = createMysqlDriver("mysql://x", { pool, ...quiet });
    await driver.init();
    driver.writeDoc(SHARED_SCOPE, "team", []);
    await driver.close();
    expect(pool.rows.size).toBe(1);
    expect(pool.ended).toBe(true);
  });

  it("builds its default pool from the URL in UTC/utf8mb4 (mysql2 mocked — no network)", async () => {
    createPoolMock.mockReturnValue(createFakeMysqlPool());
    const driver = createMysqlDriver("mysql://u:p@mysql:3306/invokeboard", quiet);
    await driver.init();
    expect(createPoolMock).toHaveBeenCalledWith(
      expect.objectContaining({ uri: "mysql://u:p@mysql:3306/invokeboard", timezone: "Z", charset: "utf8mb4" })
    );
  });

  it("a failed connect rejects init() and allows a later retry", async () => {
    const pool = createFakeMysqlPool();
    const real = pool.query.bind(pool);
    let down = true;
    pool.query = async (sql, params) => {
      if (down) throw new Error("ECONNREFUSED");
      return real(sql, params);
    };
    const driver = createMysqlDriver("mysql://x", { pool, ...quiet });
    await expect(driver.init()).rejects.toThrow("ECONNREFUSED");
    down = false;
    await expect(driver.init()).resolves.toBeUndefined();
  });

  it("redactMysqlUrl hides the password only", () => {
    expect(redactMysqlUrl("mysql://app:s3cr@t@db:3306/x")).toBe("mysql://app:***@db:3306/x");
    expect(redactMysqlUrl("mysql://db:3306/x")).toBe("mysql://db:3306/x");
  });
});

describe("doc bundle (v1.74)", () => {
  const docs: BundleDoc[] = [
    { scope: "u2", name: "journal", updated_at: null, data: { a: 1 } },
    { scope: "shared", name: "team", updated_at: "2026-10-07T00:00:00.000Z", data: ["x"] },
    { scope: "shared", name: "leaves", updated_at: null, data: {} },
  ];

  it("makeBundle sorts by (scope, name) and stamps format/count", () => {
    const b = makeBundle("sqlite:/data/x.sqlite", docs, new Date("2026-10-07T01:02:03Z"));
    expect(b.format).toBe(BUNDLE_FORMAT);
    expect(b.count).toBe(3);
    expect(b.exportedAt).toBe("2026-10-07T01:02:03.000Z");
    expect(b.docs.map((d) => `${d.scope}/${d.name}`)).toEqual(["shared/leaves", "shared/team", "u2/journal"]);
  });

  it("parseBundle accepts its own output and rejects foreign/malformed files", () => {
    const b = makeBundle("json", docs);
    expect(parseBundle(JSON.parse(JSON.stringify(b)))).toEqual(b);
    expect(() => parseBundle({ hello: "world" })).toThrow(/Not an InvokeBoard doc bundle/);
    expect(() => parseBundle({ ...b, count: 99 })).toThrow(/count mismatch/);
    expect(() => parseBundle({ ...b, count: 1, docs: [{ scope: 1, name: "x", data: 1 }] })).toThrow(/Malformed/);
  });

  it("stableStringify ignores key order but not values", () => {
    expect(stableStringify({ a: 1, b: { d: [1, { y: 1, x: 2 }], c: null } })).toBe(
      stableStringify({ b: { c: null, d: [1, { x: 2, y: 1 }] }, a: 1 })
    );
    expect(stableStringify({ a: [1, 2] })).not.toBe(stableStringify({ a: [2, 1] }));
  });

  it("round-trips sqlite → bundle → mysql with every doc verified", async () => {
    // 1) a sqlite source table, shaped exactly like sqliteDriver.ts's
    const src = new Database(":memory:");
    src.exec("CREATE TABLE docs (scope TEXT, name TEXT, data TEXT, updated_at TEXT, PRIMARY KEY (scope, name))");
    const ins = src.prepare("INSERT INTO docs VALUES (?, ?, ?, ?)");
    ins.run("shared", "users", JSON.stringify({ users: [{ id: "u1", sealed: "v1:abc" }] }), "2026-10-01T00:00:00Z");
    ins.run("team-1", "leaves", JSON.stringify({ "7": { Ann: { "2026-10-02": "VL" } } }), "2026-10-02T00:00:00Z");
    ins.run("u1", "journal", JSON.stringify({ entries: [{ t: "ünïcødé ✓" }] }), "2026-10-03T00:00:00Z");

    // 2) export, the way storage-export.ts does it, through a JSON file round-trip
    const rows = src.prepare("SELECT scope, name, data, updated_at FROM docs").all() as Array<{
      scope: string;
      name: string;
      data: string;
      updated_at: string;
    }>;
    const bundle = parseBundle(
      JSON.parse(JSON.stringify(makeBundle("sqlite:mem", rows.map((r) => ({ ...r, data: JSON.parse(r.data) })))))
    );

    // 3) import into mysql, the way storage-import.ts does it, then verify from a fresh driver
    const db = new Map<string, FakeRow>();
    const target = createMysqlDriver("mysql://x", { pool: createFakeMysqlPool(db), ...quiet });
    await target.init();
    expect(target.countDocs()).toBe(0);
    for (const d of bundle.docs) target.writeDoc(d.scope, d.name, d.data);
    await target.flush();

    const fresh = createMysqlDriver("mysql://x", { pool: createFakeMysqlPool(db), ...quiet });
    await fresh.init();
    expect(fresh.countDocs()).toBe(3);
    for (const d of bundle.docs) {
      expect(stableStringify(fresh.readDoc(d.scope, d.name))).toBe(stableStringify(d.data));
    }
  });
});
