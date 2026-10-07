#!/usr/bin/env node
/**
 * Pull ALL live data out of the running Docker stack into ./backups/<timestamp>/ (v1.74, ADR-085).
 *
 *   node scripts/export-data.mjs [--compose-file docker-compose.yml] [--service jira]
 *
 * Produces, per run:
 *   invokeboard-export-<ts>.json   portable doc bundle (input for scripts/storage-import.ts → mysql)
 *   invokeboard-stores-<ts>.sqlite consistent online copy of the sqlite db (sqlite driver only)
 *   invokeboard-data-volume.tar.gz raw tar of the whole /data volume (belt and braces)
 *
 * The export script is copied INTO the running container first, so this works against an image
 * built before v1.74 (where better-sqlite3 is already compiled). The bundle holds SEALED TOKENS:
 * keep ./backups away from the .env that holds TOKEN_ENC_KEY. ./backups is git- and docker-ignored.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
};
const composeFile = opt("--compose-file", "docker-compose.yml");
const service = opt("--service", "jira");

const root = resolve(import.meta.dirname, "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const remoteDir = `/data/exports/${stamp}`;
const localDir = join(root, "backups", stamp);

function compose(args, { capture = false } = {}) {
  const res = spawnSync("docker", ["compose", "-f", composeFile, ...args], {
    cwd: root,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.error(`\n[export-data] FAILED: docker compose ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
  return res.stdout ?? "";
}

console.log(`[export-data] exporting from service "${service}" (${composeFile}) → ${localDir}\n`);

// 1) Ship the (possibly newer) export script + its one dependency into the running container.
compose(["exec", "-T", service, "mkdir", "-p", "/app/packages/mcp-jira/scripts", remoteDir]);
compose(["cp", "packages/mcp-jira/scripts/storage-export.ts", `${service}:/app/packages/mcp-jira/scripts/storage-export.ts`]);
compose(["cp", "packages/mcp-jira/src/lib/storage/bundle.ts", `${service}:/app/packages/mcp-jira/src/lib/storage/bundle.ts`]);

// 2) Bundle + consistent sqlite copy.
compose(["exec", "-T", service, "npx", "tsx", "packages/mcp-jira/scripts/storage-export.ts", "--out", remoteDir]);

// 3) Raw volume tar (excluding previous exports).
compose(["exec", "-T", service, "tar", "czf", `${remoteDir}/invokeboard-data-volume.tar.gz`, "-C", "/data", "--exclude=./exports", "."]);

// 4) Copy everything to the host.
mkdirSync(join(root, "backups"), { recursive: true });
compose(["cp", `${service}:${remoteDir}`, localDir]);

// 5) Verify the bundle count against the live table (sqlite driver only).
const bundleName = readdirSync(localDir).find((f) => f.startsWith("invokeboard-export-") && f.endsWith(".json"));
const bundle = JSON.parse(readFileSync(join(localDir, bundleName), "utf8"));
if (bundle.source.startsWith("sqlite:")) {
  const dbFile = bundle.source.slice("sqlite:".length);
  const live = compose(
    ["exec", "-T", service, "node", "-e",
      `const D=require('better-sqlite3');const db=new D(${JSON.stringify(dbFile)},{readonly:true});console.log(db.prepare('SELECT COUNT(*) c FROM docs').get().c)`],
    { capture: true }
  ).trim();
  const ok = Number(live) === bundle.count;
  console.log(`\n[export-data] verify: live docs=${live}, bundle docs=${bundle.count} → ${ok ? "OK" : "MISMATCH"}`);
  if (!ok) process.exit(2);
}

console.log(`\n[export-data] done → ${localDir}`);
for (const f of readdirSync(localDir)) console.log(`  ${f}`);
console.log("\n!! Contains sealed tokens. Keep ./backups separate from .env (TOKEN_ENC_KEY).");
