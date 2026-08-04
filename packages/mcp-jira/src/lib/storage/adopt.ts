/**
 * Scope adoption (v1.73, ADR-084) — a one-time seeding helper for teams. When a user's existing
 * personal documents (leaves, retro, meeting notes, …) should become a NEW team's starting shared
 * documents, `adoptScopeDocs` copies them across without ever clobbering anything already present at
 * the target. Deliberately non-destructive and idempotent: a doc absent at the source, or already
 * present at the target, is skipped rather than overwritten — running it twice reports everything
 * `skipped` the second time.
 */

import { readDoc, writeDoc } from "./index.js";

export interface AdoptResult {
  copied: string[];
  skipped: string[];
}

/** Copy each named doc from `fromScope` to `toScope`, never overwriting an existing target doc. */
export function adoptScopeDocs(
  fromScope: string,
  toScope: string,
  names: readonly string[]
): AdoptResult {
  const copied: string[] = [];
  const skipped: string[] = [];

  for (const name of names) {
    const source = readDoc(fromScope, name);
    if (source === null) {
      skipped.push(name);
      continue;
    }
    const target = readDoc(toScope, name);
    if (target !== null) {
      skipped.push(name);
      continue;
    }
    writeDoc(toScope, name, source);
    copied.push(name);
  }

  return { copied, skipped };
}
