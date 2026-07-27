// useBulkRun — sequential bulk-write machine, extracted from Linking.tsx's
// handleCreateAll/handleRetryFailed (v1.11, ADR-022) and generalized for the "Link
// existing" and "New PO from Dev tasks" modes (v1.72, ADR-083) so all three Linking
// modes (and any future bulk-write flow) share one implementation.

import { useCallback, useRef, useState } from "react";
import type { McpError } from "../lib/mcpClient";

export type BulkRowStatus = "pending" | "ok" | "error";

export interface BulkRow<TDetail> {
  id: string;
  label: string;
  status: BulkRowStatus;
  detail?: TDetail;
  error?: string;
}

export interface UseBulkRun<TItem, TDetail> {
  rows: BulkRow<TDetail>[];
  running: boolean;
  done: boolean;
  okCount: number;
  errCount: number;
  run: (items: TItem[]) => Promise<void>;
  retryFailed: () => Promise<void>;
  reset: () => void;
}

/**
 * `perItem` performs the write for ONE item. `run` seeds every row `pending` then
 * processes items SEQUENTIALLY (`for...of` + `await`, NEVER `Promise.all`) — deliberate:
 * it streams the live status log and avoids hammering Jira with a burst of concurrent
 * writes. `retryFailed` re-runs ONLY rows currently `"error"`, leaving `"ok"` rows
 * untouched (it never re-invokes `perItem` for a row that already succeeded); it replays
 * the same item objects from the last `run` call via a ref, so callers don't have to
 * re-supply the item list.
 */
export function useBulkRun<TItem extends { id: string; label: string }, TDetail>(
  perItem: (item: TItem) => Promise<TDetail>
): UseBulkRun<TItem, TDetail> {
  const [rows, setRows] = useState<BulkRow<TDetail>[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const itemsRef = useRef<TItem[]>([]);

  const processSequentially = useCallback(
    async (items: TItem[], onlyIds?: Set<string>) => {
      setRunning(true);
      for (const item of items) {
        if (onlyIds && !onlyIds.has(item.id)) continue;
        try {
          const detail = await perItem(item);
          setRows((prev) =>
            prev.map((r) =>
              r.id === item.id
                ? { id: item.id, label: item.label, status: "ok", detail }
                : r
            )
          );
        } catch (err: unknown) {
          const e = err as McpError;
          setRows((prev) =>
            prev.map((r) =>
              r.id === item.id
                ? {
                    id: item.id,
                    label: item.label,
                    status: "error",
                    error: e.message ?? String(err),
                  }
                : r
            )
          );
        }
      }
      setRunning(false);
      setDone(true);
    },
    [perItem]
  );

  const run = useCallback(
    async (items: TItem[]) => {
      itemsRef.current = items;
      setDone(false);
      setRows(items.map((item) => ({ id: item.id, label: item.label, status: "pending" as const })));
      await processSequentially(items);
    },
    [processSequentially]
  );

  // v1.72 (ADR-083): re-run ONLY the rows that failed, leaving successes alone.
  const retryFailed = useCallback(async () => {
    const failedIds = new Set(rows.filter((r) => r.status === "error").map((r) => r.id));
    if (failedIds.size === 0) return;
    setDone(false);
    setRows((prev) =>
      prev.map((r) => (failedIds.has(r.id) ? { ...r, status: "pending" as const } : r))
    );
    await processSequentially(itemsRef.current, failedIds);
  }, [rows, processSequentially]);

  const reset = useCallback(() => {
    setRows([]);
    setRunning(false);
    setDone(false);
    itemsRef.current = [];
  }, []);

  const okCount = rows.filter((r) => r.status === "ok").length;
  const errCount = rows.filter((r) => r.status === "error").length;

  return { rows, running, done, okCount, errCount, run, retryFailed, reset };
}
