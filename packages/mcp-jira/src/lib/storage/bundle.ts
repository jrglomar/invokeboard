/**
 * Portable doc bundle (v1.74, ADR-085) — the driver-neutral file format `scripts/storage-export.ts`
 * writes and `scripts/storage-import.ts` reads. One bundle holds EVERY (scope, name) doc of a
 * deployment, so it is the hand-off artifact for moving data between drivers/hosts (sqlite on the
 * old box → mysql on the server). It contains sealed tokens (the `users` doc) — never store it
 * alongside the `.env` that holds TOKEN_ENC_KEY (DEPLOYMENT.md §5.5).
 *
 * Deliberately dependency-free (no config/driver imports) so the export script can be copied into
 * an older running container and still type-check/run against just this file.
 */

export const BUNDLE_FORMAT = "invokeboard-docs/1";

export interface BundleDoc {
  scope: string;
  name: string;
  /** ISO timestamp of the doc's last write at the source, when the source tracks one. */
  updated_at: string | null;
  data: unknown;
}

export interface DocBundle {
  format: typeof BUNDLE_FORMAT;
  exportedAt: string;
  /** Where the docs came from, e.g. "sqlite:/data/.invokeboard-stores.sqlite" or "json". */
  source: string;
  count: number;
  docs: BundleDoc[];
}

/** Build a bundle with docs sorted by (scope, name) so two exports of the same data diff cleanly. */
export function makeBundle(source: string, docs: BundleDoc[], now: Date = new Date()): DocBundle {
  const sorted = [...docs].sort((a, b) =>
    a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope.localeCompare(b.scope)
  );
  return { format: BUNDLE_FORMAT, exportedAt: now.toISOString(), source, count: sorted.length, docs: sorted };
}

/** Validate a parsed bundle file; throws a clear error on anything that isn't a v1 bundle. */
export function parseBundle(raw: unknown): DocBundle {
  const b = raw as Partial<DocBundle> | null;
  if (!b || typeof b !== "object" || b.format !== BUNDLE_FORMAT || !Array.isArray(b.docs)) {
    throw new Error(`Not an InvokeBoard doc bundle (expected format "${BUNDLE_FORMAT}").`);
  }
  for (const d of b.docs) {
    if (!d || typeof d.scope !== "string" || typeof d.name !== "string" || !("data" in d)) {
      throw new Error("Malformed bundle doc: every doc needs string scope/name and a data field.");
    }
  }
  if (b.count !== b.docs.length) {
    throw new Error(`Bundle count mismatch: header says ${b.count}, file holds ${b.docs.length} docs.`);
  }
  return b as DocBundle;
}

/** JSON with object keys sorted — a structural equality key independent of key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
