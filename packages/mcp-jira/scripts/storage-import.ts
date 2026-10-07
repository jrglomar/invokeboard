/**
 * Load a doc bundle into the CONFIGURED storage driver (v1.74, ADR-085).
 *
 *   npx tsx packages/mcp-jira/scripts/storage-import.ts <bundle.json> [--force]
 *
 * Typical use: moving the exported sqlite data into MySQL on the server
 * (`STORAGE_DRIVER=mysql`, see DEPLOYMENT.md §9). Steps:
 *  1. initStorage() — for mysql: connect, create `docs`, preload.
 *  2. Refuse when the target already holds docs (unless --force, which upserts over them).
 *  3. writeDoc every bundle doc, then flushStorage() so the write-behind queue lands.
 *  4. VERIFY from a FRESH driver (cache dropped → mysql re-reads from the database): every doc must
 *     deep-equal the bundle. Exit 0 only on `verified N/N`.
 */

import * as fs from "fs";
import { getConfig } from "../src/lib/config.js";
import {
  countDocs,
  flushStorage,
  initStorage,
  readDoc,
  resetStorageCache,
  writeDoc,
} from "../src/lib/storage/index.js";
import { parseBundle, stableStringify } from "../src/lib/storage/bundle.js";

async function main(): Promise<void> {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const force = process.argv.includes("--force");
  if (!file) throw new Error("usage: storage-import.ts <bundle.json> [--force]");

  const bundle = parseBundle(JSON.parse(fs.readFileSync(file, "utf8")));
  const driver = getConfig().STORAGE_DRIVER;
  if (driver === "json") {
    throw new Error("storage-import targets STORAGE_DRIVER=sqlite or mysql (json stores are plain files — copy them instead).");
  }

  await initStorage();
  const existing = countDocs() ?? 0;
  if (existing > 0 && !force) {
    throw new Error(`target ${driver} store already holds ${existing} doc(s) — refusing to import. Re-run with --force to upsert over them.`);
  }

  console.log(`[storage-import] ${bundle.count} doc(s) from ${file} (exported ${bundle.exportedAt}, source ${bundle.source}) → ${driver}`);
  for (const d of bundle.docs) writeDoc(d.scope, d.name, d.data);
  await flushStorage();
  console.log(`[storage-import] imported ${bundle.count}`);

  // Verify against a fresh driver so mysql re-reads from the database, not the write-behind cache.
  resetStorageCache();
  await initStorage();
  const mismatches: string[] = [];
  for (const d of bundle.docs) {
    if (stableStringify(readDoc(d.scope, d.name)) !== stableStringify(d.data)) {
      mismatches.push(`scope=${d.scope} name=${d.name}`);
    }
  }
  const verified = bundle.count - mismatches.length;
  console.log(`[storage-import] verified ${verified}/${bundle.count}`);
  if (mismatches.length > 0) {
    for (const m of mismatches) console.error(`  MISMATCH ${m}`);
    process.exit(2);
  }
  process.exit(0); // the mysql pool would otherwise keep the process alive
}

main().catch((err) => {
  console.error(`[storage-import] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
