/**
 * In-memory stand-in for a mysql2 promise pool (v1.74, ADR-085) — understands exactly the three
 * statements mysqlDriver.ts issues (CREATE TABLE, SELECT all, upsert). Offline; no real MySQL.
 * Pass the same `rows` map to two pools to simulate a process restart against one database.
 */

import type { SqlPool } from "../../src/lib/storage/mysqlDriver.js";

export interface FakeRow {
  scope: string;
  name: string;
  /** string like a LONGTEXT column, or an object like mysql2's parsed JSON column. */
  data: unknown;
  updated_at: Date;
}

export interface FakeMysqlPool extends SqlPool {
  rows: Map<string, FakeRow>;
  upserts: number;
  /** Number of upcoming upserts that should reject (simulated connection loss). */
  failNext: number;
  ended: boolean;
}

export function createFakeMysqlPool(rows: Map<string, FakeRow> = new Map()): FakeMysqlPool {
  const pool: FakeMysqlPool = {
    rows,
    upserts: 0,
    failNext: 0,
    ended: false,
    async query(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
      const stmt = sql.trim();
      if (stmt.startsWith("CREATE TABLE")) return [[], []];
      if (stmt.startsWith("SELECT")) return [[...rows.values()].map((r) => ({ ...r })), []];
      if (stmt.startsWith("INSERT")) {
        if (pool.failNext > 0) {
          pool.failNext--;
          throw new Error("ECONNRESET (fake)");
        }
        const [scope, name, data, updatedAt] = params as [string, string, string, Date];
        pool.upserts++;
        rows.set(`${scope}\u0000${name}`, { scope, name, data, updated_at: updatedAt });
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`fake mysql pool: unexpected SQL: ${stmt}`);
    },
    async end(): Promise<void> {
      pool.ended = true;
    },
  };
  return pool;
}
