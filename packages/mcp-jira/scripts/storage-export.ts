/**
 * Export every stored doc to a portable bundle (v1.74, ADR-085).
 *
 *   npx tsx packages/mcp-jira/scripts/storage-export.ts --out <dir>
 *
 * Reads the CONFIGURED source (STORAGE_DRIVER / STORAGE_SQLITE_FILE from the environment):
 *  - sqlite → every row of `docs`, plus a consistent raw copy of the db via better-sqlite3's
 *    online `backup()` (WAL-safe while the bridge keeps running).
 *  - json   → the same docs the sqlite auto-import would find (`loadJsonImportCandidates`).
 * Writes `<dir>/invokeboard-export-<ts>.json` (see storage/bundle.ts) and prints per-store counts.
 *
 * Imports only `bundle.ts` statically (json mode loads autoImport lazily) so `scripts/export-data.mjs`
 * can copy this file + bundle.ts into an OLDER running container and run it there, where
 * better-sqlite3 is already compiled.
 */

import * as fs from "fs";
import * as path from "path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { makeBundle, type BundleDoc } from "../src/lib/storage/bundle.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Same base config.ts resolves relative store paths against (the mcp-jira package dir).
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const outDir = path.resolve(argValue("--out") ?? "exports");
  const driver = process.env["STORAGE_DRIVER"] || "json";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(outDir, { recursive: true });

  let docs: BundleDoc[];
  let source: string;

  if (driver === "sqlite") {
    const file = path.resolve(packageDir, process.env["STORAGE_SQLITE_FILE"] || ".invokeboard-stores.sqlite");
    if (!fs.existsSync(file)) throw new Error(`sqlite store not found: ${file}`);
    source = `sqlite:${file}`;
    // better-sqlite3 is an optional native dep — load lazily, like sqliteDriver.ts.
    const Database = createRequire(import.meta.url)("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT scope, name, data, updated_at FROM docs").all() as {
      scope: string;
      name: string;
      data: string;
      updated_at: string;
    }[];
    docs = rows.map((r) => ({ scope: r.scope, name: r.name, updated_at: r.updated_at, data: JSON.parse(r.data) }));
    const copy = path.join(outDir, `invokeboard-stores-${stamp}.sqlite`);
    await db.backup(copy);
    db.close();
    console.log(`raw sqlite copy  -> ${copy}`);
  } else if (driver === "json") {
    source = "json";
    const { loadJsonImportCandidates } = await import("../src/lib/storage/autoImport.js");
    docs = loadJsonImportCandidates().map((d) => ({ ...d, updated_at: null }));
  } else {
    throw new Error(`storage-export supports STORAGE_DRIVER=sqlite|json (got "${driver}"); for mysql use mysqldump (scripts/backup-mysql.sh).`);
  }

  const bundle = makeBundle(source, docs);
  const bundleFile = path.join(outDir, `invokeboard-export-${stamp}.json`);
  fs.writeFileSync(bundleFile, JSON.stringify(bundle, null, 2) + "\n");

  const byName = new Map<string, number>();
  for (const d of bundle.docs) byName.set(d.name, (byName.get(d.name) ?? 0) + 1);
  const scopes = new Set(bundle.docs.map((d) => d.scope));
  console.log(`bundle           -> ${bundleFile}`);
  console.log(`source           :  ${source}`);
  console.log(`docs             :  ${bundle.count} across ${scopes.size} scope(s)`);
  for (const [name, n] of [...byName].sort()) console.log(`  ${name.padEnd(16)} ${n}`);
  console.log("\n!! The bundle contains SEALED TOKENS. Never store it next to the .env holding TOKEN_ENC_KEY.");
}

main().catch((err) => {
  console.error(`[storage-export] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
