/**
 * MySQL storage driver (v1.74, ADR-085) — `STORAGE_DRIVER=mysql`, for the server deployment.
 * Same one-table shape as the sqlite driver: `docs(scope, name, data, updated_at)` keyed by
 * (scope, name). `data` is LONGTEXT + a JSON_VALID check, NOT a native JSON column: MySQL re-sorts
 * object keys in JSON columns, and stores may rely on insertion order — text round-trips exactly
 * like sqlite while MySQL JSON functions still work on it.
 *
 * The storage port is SYNCHRONOUS (port.ts) but every MySQL client is async, so this driver is a
 * write-behind cache rather than a pass-through:
 *  - `init()` (awaited once at startup via `initStorage()`) creates the table and preloads EVERY row
 *    into an in-memory map of serialized JSON. Reads are then pure map lookups + `JSON.parse`, so
 *    each caller gets a fresh object exactly like the sqlite driver's parse-per-read.
 *  - `writeDoc` updates the cache synchronously (read-your-writes holds immediately) and enqueues an
 *    upsert. One pump drains the queue serially; repeated writes to the same key coalesce to the
 *    latest value. A failed upsert is re-queued (unless a newer write superseded it) and retried
 *    with capped exponential backoff — it is logged, never thrown into the request.
 *  - `flush()` waits (bounded) for the queue to drain; the entries call it on SIGTERM/SIGINT.
 *
 * Trade-off (documented in DEPLOYMENT.md): a hard kill can lose writes still queued, and the cache
 * makes the one-replica rule load-bearing — a second bridge instance would read a stale cache.
 */

import { createPool } from "mysql2/promise";
import type { StorageDriver } from "./port.js";

/** The slice of a mysql2 promise pool this driver uses — lets tests inject an in-memory fake. */
export interface SqlPool {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

export interface MysqlDriverOptions {
  /** Injectable for tests (default: a mysql2 pool on the given URL). */
  pool?: SqlPool;
  /** Injectable for tests (default: stderr — stdout carries MCP frames in the stdio entry). */
  log?: (message: string) => void;
  logError?: (message: string) => void;
  /** First retry delay; doubles per consecutive failure up to `retryMaxMs`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Upper bound on how long `flush()` waits for the queue to drain. */
  flushTimeoutMs?: number;
}

export interface MysqlStorageDriver extends StorageDriver {
  init(): Promise<void>;
  flush(): Promise<void>;
  countDocs(): number;
  /** Writes queued but not yet persisted (for logs/tests). */
  pendingCount(): number;
  /** Flush, then release the pool. */
  close(): Promise<void>;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS docs (
    scope VARCHAR(191) NOT NULL,
    name VARCHAR(191) NOT NULL,
    data LONGTEXT NOT NULL CHECK (JSON_VALID(data)),
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (scope, name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
`;

const UPSERT_SQL =
  "INSERT INTO docs (scope, name, data, updated_at) VALUES (?, ?, ?, ?) " +
  "ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)";

interface PendingWrite {
  scope: string;
  name: string;
  json: string;
}

/** A NUL separator can't appear in a scope (user id/team id) or a store name. */
const keyOf = (scope: string, name: string): string => `${scope}\u0000${name}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Redact the password in a mysql:// URL for log lines. */
export function redactMysqlUrl(url: string): string {
  // Greedy to the LAST "@" — a password may itself contain "@" (the host part never does).
  return url.replace(/^(mysql:\/\/[^:/@]+:).*@/i, "$1***@");
}

export function createMysqlDriver(url: string, opts: MysqlDriverOptions = {}): MysqlStorageDriver {
  const log = opts.log ?? ((m: string) => void process.stderr.write(m + "\n"));
  const logError = opts.logError ?? log;
  const retryBaseMs = opts.retryBaseMs ?? 250;
  const retryMaxMs = opts.retryMaxMs ?? 30_000;
  const flushTimeoutMs = opts.flushTimeoutMs ?? 8_000;

  let pool: SqlPool | null = opts.pool ?? null;
  const cache = new Map<string, string>();
  const pending = new Map<string, PendingWrite>();
  let initPromise: Promise<void> | null = null;
  let ready = false;
  let pumping = false;
  let idleWaiters: Array<() => void> = [];

  function getPool(): SqlPool {
    if (!pool) {
      // utf8mb4 + UTC so DATETIME(3) round-trips identically regardless of server/host timezone.
      pool = createPool({ uri: url, connectionLimit: 4, charset: "utf8mb4", timezone: "Z" }) as unknown as SqlPool;
    }
    return pool;
  }

  function assertReady(): void {
    if (!ready) {
      throw new Error(
        "STORAGE_DRIVER=mysql: storage used before initStorage() finished — the entry point must " +
          "await initStorage() before serving requests."
      );
    }
  }

  async function upsert(w: PendingWrite): Promise<void> {
    await getPool().query(UPSERT_SQL, [w.scope, w.name, w.json, new Date()]);
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    let failures = 0;
    try {
      while (pending.size > 0) {
        const [key, write] = pending.entries().next().value as [string, PendingWrite];
        pending.delete(key);
        try {
          await upsert(write);
          failures = 0;
        } catch (err) {
          // Keep the write unless a newer one for the same key has already been queued.
          if (!pending.has(key)) pending.set(key, write);
          failures++;
          const delay = Math.min(retryBaseMs * 2 ** (failures - 1), retryMaxMs);
          logError(
            `[storage] mysql write FAILED for scope=${write.scope} name=${write.name} ` +
              `(attempt ${failures}, ${pending.size} pending; retrying in ${delay}ms): ` +
              (err instanceof Error ? err.message : String(err))
          );
          await sleep(delay);
        }
      }
    } finally {
      pumping = false;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  async function flush(): Promise<void> {
    if (!pumping && pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((r) => idleWaiters.push(r)),
      new Promise<void>((r) => {
        timer = setTimeout(r, flushTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (pending.size > 0) {
      logError(`[storage] mysql flush timed out after ${flushTimeoutMs}ms — ${pending.size} write(s) NOT persisted.`);
    }
  }

  return {
    init(): Promise<void> {
      if (!initPromise) {
        initPromise = (async () => {
          const p = getPool();
          await p.query(CREATE_TABLE_SQL);
          const [rows] = await p.query("SELECT scope, name, data FROM docs");
          for (const row of rows as Array<{ scope: string; name: string; data: unknown }>) {
            // mysql2 hands JSON columns back already parsed; normalize to the serialized form.
            const json = typeof row.data === "string" ? row.data : JSON.stringify(row.data);
            cache.set(keyOf(row.scope, row.name), json);
          }
          ready = true;
          log(`[storage] STORAGE_DRIVER=mysql (${redactMysqlUrl(url)}): loaded ${cache.size} doc(s) into the cache.`);
        })().catch((err: unknown) => {
          initPromise = null; // allow a retry after a failed connect
          throw err;
        });
      }
      return initPromise;
    },

    readDoc(scope: string, name: string): unknown {
      assertReady();
      const json = cache.get(keyOf(scope, name));
      if (json === undefined) return null;
      try {
        return JSON.parse(json) as unknown;
      } catch {
        return null;
      }
    },

    writeDoc(scope: string, name: string, data: unknown): void {
      assertReady();
      const json = JSON.stringify(data);
      const key = keyOf(scope, name);
      cache.set(key, json);
      pending.set(key, { scope, name, json }); // same key → value replaced in place (coalesced)
      void pump();
    },

    flush,

    countDocs(): number {
      assertReady();
      return cache.size;
    },

    pendingCount(): number {
      return pending.size;
    },

    async close(): Promise<void> {
      await flush();
      if (pool) await pool.end();
      pool = null;
      ready = false;
      initPromise = null;
    },
  };
}
