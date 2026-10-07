/**
 * Storage port (v1.65, ADR-077) — the interface every §4/§8 host-local store now reads and
 * writes through, instead of touching `fs` directly. Two drivers implement it identically:
 * `jsonDriver.ts` (default — today's per-file behavior, byte-identical) and `sqliteDriver.ts`
 * (production — one `better-sqlite3` database file). Selection lives in `index.ts`.
 *
 * A "doc" is identified by (scope, name):
 *  - `name` is the store's stable identifier ("leaves", "team", "post-scrum", "journal", …) —
 *    the same string used for the per-user JSON basename today (`<name>.json`).
 *  - `scope` is `SHARED_SCOPE` for the team-wide stores' non-per-user case, or a user id for a
 *    per-user store (either the storeUserId from ADR-056, or a journal's REAL user id).
 *
 * Both methods are SYNCHRONOUS — that's the whole point of choosing better-sqlite3, which is a
 * synchronous native binding. The store/tool/route call graph stays sync end to end (no async
 * ripple). A driver TRUSTS the `scope` it is given; it never reads AsyncLocalStorage context
 * itself — callers (store modules) resolve scope from request context and pass it in, so the
 * driver stays a pure, predictable function of its arguments (this is what makes the per-scope
 * isolation contract test meaningful for both drivers).
 */

/** The scope used by team-wide stores when there is no active per-user request context. */
export const SHARED_SCOPE = "shared";

/** Implemented identically by the json and sqlite drivers (see jsonDriver.ts / sqliteDriver.ts). */
export interface StorageDriver {
  /** The stored value for (scope, name), or `null` when absent/unreadable/corrupt — never throws. */
  readDoc(scope: string, name: string): unknown;
  /** Persist `data` for (scope, name), replacing any previous value. May throw on FS/DB errors. */
  writeDoc(scope: string, name: string, data: unknown): void;
  /**
   * v1.74 (ADR-085) — optional async lifecycle, only implemented by drivers that need it (mysql).
   * `init` must resolve before the first readDoc/writeDoc; `flush` waits for pending writes.
   */
  init?(): Promise<void>;
  flush?(): Promise<void>;
  /** Total docs stored (all scopes) — used by the import script's empty-target guard. */
  countDocs?(): number;
}
