/**
 * Storage driver selection (v1.65, ADR-077) — the facade every store module imports. Picks the
 * driver from `STORAGE_DRIVER` (config.ts), builds it once, and reuses it for the life of the
 * process (memoized, like `getConfig()`'s `cachedConfig`). `resetStorageCache()` mirrors
 * `resetConfigCache()` for tests that flip `STORAGE_DRIVER`/`STORAGE_SQLITE_FILE` mid-suite.
 */

import { getConfig, getStorageSqliteFilePath } from "../config.js";
import { getRequestStoreUserId } from "../requestContext.js";
import { createJsonDriver } from "./jsonDriver.js";
import { createSqliteDriver } from "./sqliteDriver.js";
import { createMysqlDriver } from "./mysqlDriver.js";
import { loadJsonImportCandidates } from "./autoImport.js";
import { resolveJsonOverride } from "./registry.js";
import { SHARED_SCOPE, type StorageDriver } from "./port.js";

export { SHARED_SCOPE } from "./port.js";
export type { StorageDriver } from "./port.js";

let cachedDriver: StorageDriver | null = null;

function buildDriver(): StorageDriver {
  const cfg = getConfig();
  if (cfg.STORAGE_DRIVER === "sqlite") {
    return createSqliteDriver(getStorageSqliteFilePath(), {
      loadImportCandidates: loadJsonImportCandidates,
    });
  }
  if (cfg.STORAGE_DRIVER === "mysql") {
    return createMysqlDriver(cfg.STORAGE_MYSQL_URL.trim());
  }
  return createJsonDriver({ resolveOverride: resolveJsonOverride });
}

function getDriver(): StorageDriver {
  if (!cachedDriver) cachedDriver = buildDriver();
  return cachedDriver;
}

/**
 * v1.74 (ADR-085) — prepare the configured driver before the first request: a no-op for json/sqlite
 * (they open lazily and synchronously), connect + create table + preload for mysql. Both entries
 * (http.ts, stdio index.ts) await this before serving.
 */
export async function initStorage(): Promise<void> {
  await getDriver().init?.();
}

/** v1.74 — wait for queued writes to persist (mysql write-behind); a no-op for json/sqlite. */
export async function flushStorage(): Promise<void> {
  await getDriver().flush?.();
}

/** Total stored docs, or null when the driver can't count (json). Used by the import script. */
export function countDocs(): number | null {
  return getDriver().countDocs?.() ?? null;
}

/** Clear the memoized driver — tests use this after changing STORAGE_DRIVER/STORAGE_SQLITE_FILE. */
export function resetStorageCache(): void {
  cachedDriver = null;
}

/** The stored value for (scope, name), or `null` when absent — see StorageDriver.readDoc. */
export function readDoc(scope: string, name: string): unknown {
  return getDriver().readDoc(scope, name);
}

/** Persist `data` for (scope, name) — see StorageDriver.writeDoc. */
export function writeDoc(scope: string, name: string, data: unknown): void {
  getDriver().writeDoc(scope, name, data);
}

/**
 * The scope a team-wide store (leaves/team/impediments/prs/post-scrum/meeting-goal/
 * meeting-notes/retro/offset) should use: the ADR-056 storeUserId inside a per-user request
 * context, else SHARED_SCOPE — the exact same source `resolveStorePath` (config.ts) reads
 * today. `users` (always SHARED_SCOPE) and `journal` (always the real user id) don't use this;
 * they pass their own scope explicitly.
 */
export function currentScope(): string {
  return getRequestStoreUserId() ?? SHARED_SCOPE;
}
