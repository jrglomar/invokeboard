/**
 * SQLite storage driver (v1.65, ADR-077) — `STORAGE_DRIVER=sqlite`, the production option.
 * One `better-sqlite3` database file backs every store, in a single `docs` table keyed by
 * (scope, name). better-sqlite3 is SYNCHRONOUS, matching the port's contract exactly — no
 * async ripple into the store/tool/route call graph.
 *
 * The connection is a lazy singleton: `new Database(filePath)` doesn't happen until the first
 * `readDoc`/`writeDoc` call, and every call after that reuses the same handle. WAL mode is
 * enabled on open (better-sqlite3 silently uses its in-memory journal for `:memory:` instead —
 * harmless, not an error).
 *
 * Auto-import (item 189, ADR-077): the FIRST time the table is found empty (fresh db file, or a
 * fresh `:memory:` instance in tests), an injected `loadImportCandidates()` is asked for every
 * doc that exists in the JSON stores today; all of them are inserted in one transaction and the
 * import is logged loudly. `runAutoImportIfEmpty` is exported separately (not just inlined into
 * `ensureOpen`) so tests can drive the empty-table guard directly against a live `Database`
 * handle without needing a real process restart to prove "a second open imports nothing."
 */

// better-sqlite3 is an OPTIONAL, native dependency (v1.65, ADR-077 revised): it ships prebuilt
// binaries but has no musl build and can fall back to compiling from source, which fails in build
// environments without a prebuilt-binary download or a C/Python toolchain. To keep the WHOLE app
// buildable and runnable on the default json driver even when better-sqlite3 can't install, its
// value is loaded LAZILY (only when STORAGE_DRIVER=sqlite actually builds this driver) — a static
// top-level import here would pull it into every store's module graph and crash on absence. The
// TYPE import below is erased at runtime, so it never triggers a require.
import { createRequire } from "node:module";
import type DatabaseType from "better-sqlite3"; // types only — erased at runtime (better-sqlite3 uses `export =`)
import type { StorageDriver } from "./port.js";

type DatabaseHandle = DatabaseType.Database;
type BetterSqlite3Ctor = new (path: string, options?: DatabaseType.Options) => DatabaseHandle;

/** Load the better-sqlite3 constructor on first use; a clear error if the optional dep is absent. */
function loadDatabaseCtor(): BetterSqlite3Ctor {
  try {
    return createRequire(import.meta.url)("better-sqlite3") as BetterSqlite3Ctor;
  } catch {
    throw new Error(
      "STORAGE_DRIVER=sqlite needs the optional 'better-sqlite3' package, which is not installed " +
        "(its native binary failed to build — it needs either a prebuilt-binary download or a " +
        "C/Python build toolchain). Set STORAGE_DRIVER=json (the default) to run without it, or " +
        "rebuild in an environment where better-sqlite3 can install."
    );
  }
}

/** One doc discovered in a JSON store, ready to insert into `docs`. */
export interface JsonDocRef {
  scope: string;
  name: string;
  data: unknown;
}

export interface SqliteDriverOptions {
  /** Called once, only when `docs` is empty at open time, to gather docs to import. */
  loadImportCandidates?: () => JsonDocRef[];
  /** Injectable for tests (default: console.log). Receives the whole multi-line message. */
  log?: (message: string) => void;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS docs (
    scope TEXT NOT NULL,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, name)
  )
`;

const UPSERT_SQL =
  "INSERT OR REPLACE INTO docs (scope, name, data, updated_at) VALUES (?, ?, ?, ?)";

function defaultLog(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

/**
 * Import every candidate doc into `docs`, but ONLY when the table is currently empty — a
 * no-op (no log, no query beyond the COUNT) once anything exists, including from a prior
 * import or from ordinary writes. Exported so it can be exercised directly against one
 * `Database` handle to prove idempotency without a real process restart.
 */
export function runAutoImportIfEmpty(db: DatabaseHandle, opts: SqliteDriverOptions = {}): void {
  const row = db.prepare("SELECT COUNT(*) AS count FROM docs").get() as { count: number };
  if (row.count > 0) return;

  const candidates = opts.loadImportCandidates?.() ?? [];
  if (candidates.length === 0) return;

  const now = new Date().toISOString();
  const insert = db.prepare(UPSERT_SQL);
  const importAll = db.transaction((docs: JsonDocRef[]) => {
    for (const doc of docs) insert.run(doc.scope, doc.name, JSON.stringify(doc.data), now);
  });
  importAll(candidates);

  const log = opts.log ?? defaultLog;
  log(
    [
      "",
      "=".repeat(72),
      "[storage] STORAGE_DRIVER=sqlite, first boot: docs table was empty.",
      `[storage] Auto-imported ${candidates.length} doc(s) from the JSON stores:`,
      ...candidates.map((d) => `[storage]   - scope=${d.scope} name=${d.name}`),
      "[storage] The original JSON files were left untouched (they now double as a backup).",
      "[storage] This import runs exactly once — it will not run again now that docs exist.",
      "=".repeat(72),
      "",
    ].join("\n")
  );
}

export function createSqliteDriver(filePath: string, opts: SqliteDriverOptions = {}): StorageDriver {
  let db: DatabaseHandle | null = null;

  function ensureOpen(): DatabaseHandle {
    if (db) return db;
    const conn = new (loadDatabaseCtor())(filePath);
    conn.pragma("journal_mode = WAL");
    conn.exec(CREATE_TABLE_SQL);
    runAutoImportIfEmpty(conn, opts);
    db = conn;
    return conn;
  }

  return {
    readDoc(scope: string, name: string): unknown {
      const row = ensureOpen()
        .prepare("SELECT data FROM docs WHERE scope = ? AND name = ?")
        .get(scope, name) as { data: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.data) as unknown;
      } catch {
        return null;
      }
    },
    writeDoc(scope: string, name: string, data: unknown): void {
      ensureOpen().prepare(UPSERT_SQL).run(scope, name, JSON.stringify(data), new Date().toISOString());
    },
    countDocs(): number {
      return (ensureOpen().prepare("SELECT COUNT(*) AS count FROM docs").get() as { count: number }).count;
    },
  };
}
